import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type ConsentDescription,
} from '@cloudflare/workers-oauth-provider'
import type { Env, Props } from './env.js'

// OAuth front door for MCP clients. TaskSquad has no session of its own here:
// after per-client consent we hand the browser to the portal's existing PKCE
// sign-in (/mobile/authorize, the same page the iOS app uses), which returns a
// one-time code to /oauth/callback. We exchange it for a tsq_cli_* API token and
// store that token, encrypted, in the grant props.

const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60 // matches the worker's 30-day mobile token

export { REFRESH_TOKEN_TTL }

export function callbackUrl(requestUrl: string): string {
  return new URL('/oauth/callback', requestUrl).toString()
}

export function portalSignInUrl(portalBase: string, callback: string, codeChallenge: string, state: string): string {
  const url = new URL('/mobile/authorize', portalBase)
  url.searchParams.set('redirect_uri', callback)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  return url.toString()
}

export function randomVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(48)))
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

const STYLE = `
:root{--bg:#F6F7F9;--card:#fff;--ink:#0F1117;--muted:#5B6170;--border:#E2E4EA;--accent:#2563EB;--warn:#D97706}
@media (prefers-color-scheme:dark){:root{--bg:#0F1117;--card:#171A22;--ink:#F3F4F6;--muted:#9CA3AF;--border:#2A2F3A}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:24px}
h1{font-size:18px;margin:0 0 8px}p{margin:8px 0;color:var(--muted)}strong{color:var(--ink)}
.logo{width:36px;height:36px;border-radius:10px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:600;margin-bottom:14px}
.warn{color:var(--warn)}ul{margin:8px 0 0;padding-left:18px;color:var(--muted)}
.row{display:flex;gap:8px;margin-top:20px}button{flex:1;padding:10px 14px;border-radius:8px;font:inherit;font-weight:500;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--ink)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}`

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><div class="logo">T</div>${body}</main></body></html>`
}

export function consentPage(d: ConsentDescription, handle: string): string {
  const name = escapeHtml(d.clientName || d.clientId)
  const domain = d.clientDomain ? ` <span>(${escapeHtml(d.clientDomain)})</span>` : ''
  return page(`Connect ${d.clientName || 'app'} to TaskSquad`, `
<h1>Allow <strong>${name}</strong>${domain} to use TaskSquad?</h1>
<p>It will act as you: read and create tasks, reply to agents, and manage notes, conveyors, planners and portals in your projects.</p>
<ul><li>It cannot delete projects or data, change members, or create agent tokens. Those stay manual.</li></ul>
<p>Access will be sent to <strong>${escapeHtml(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<div class="row"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="approve">Continue to sign in</button></div>
</form>`)
}

function errorPage(message: string, status = 400): Response {
  return new Response(page('TaskSquad sign-in', `<h1>Can't connect</h1><p>${escapeHtml(message)}</p><p>Return to your AI app and start connecting again.</p>`), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function redirect(headers: Headers, location: string): Response {
  headers.set('Location', location)
  return new Response(null, { status: 302, headers })
}

async function authorizeGet(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER
  const request = await oauth.parseAuthRequest(req)
  const details = await oauth.describeConsent(request)
  const consent = await oauth.beginConsent(request)
  consent.headers.set('Content-Type', 'text/html; charset=utf-8')
  return new Response(consentPage(details, consent.handle), { headers: consent.headers })
}

async function authorizePost(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER
  const form = await req.formData()
  const handle = String(form.get('handle') ?? '')
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(req, handle)
    return new Response(null, { status: 302, headers: denied.headers })
  }
  const approved = await oauth.approveConsent(req, handle)
  const verifier = randomVerifier()
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers })
  return redirect(headers, portalSignInUrl(env.PORTAL_BASE, callbackUrl(req.url), await pkceChallenge(verifier), state))
}

async function callback(req: Request, env: Env, fetchImpl: typeof fetch): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req)
  const code = new URL(req.url).searchParams.get('code')
  if (!code) return redirect(headers, authorizationErrorRedirect(original, 'access_denied'))

  const exchange = await fetchImpl(`${env.API_BASE}/mobile/authorization/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: data.verifier, client: 'mcp' }),
  })
  if (!exchange.ok) return errorPage('The sign-in code was invalid or expired.', 401)
  const { token } = await exchange.json<{ token: string }>()

  const meRes = await fetchImpl(`${env.API_BASE}/me`, { headers: { Authorization: `Bearer ${token}` } })
  if (!meRes.ok) return errorPage('Could not load your TaskSquad account.', 502)
  const me = await meRes.json<{ id: string; email: string }>()

  const props: Props = { apiToken: token, userId: me.id, email: me.email }
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: me.id,
    metadata: { email: me.email },
    scope: original.scope,
    props,
  })
  return redirect(headers, redirectTo)
}

function home(env: Env, url: string): Response {
  const mcp = new URL('/mcp', url).toString()
  return new Response(page('TaskSquad MCP', `
<h1>TaskSquad MCP server</h1>
<p>Connect AI agents to your TaskSquad projects. Add this URL to your MCP client; it will ask you to sign in with your TaskSquad account.</p>
<p><strong>${escapeHtml(mcp)}</strong></p>
<p>Claude Code: <code>claude mcp add --transport http tasksquad ${escapeHtml(mcp)}</code></p>
<p><a href="${escapeHtml(env.PORTAL_BASE)}">Open TaskSquad</a></p>`), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

export function createAuthHandler(fetchImpl: typeof fetch = (i, init) => fetch(i, init)): ExportedHandler<Env> {
  return {
    async fetch(req, env) {
      const url = new URL(req.url)
      try {
        if (url.pathname === '/oauth/authorize' && req.method === 'GET') return await authorizeGet(req, env)
        if (url.pathname === '/oauth/authorize' && req.method === 'POST') return await authorizePost(req, env)
        if (url.pathname === '/oauth/callback' && req.method === 'GET') return await callback(req, env, fetchImpl)
        if (url.pathname === '/' && req.method === 'GET') return home(env, req.url)
        return new Response('Not found', { status: 404 })
      } catch (error) {
        if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302)
        if (error instanceof AuthorizationError) return errorPage(error.description)
        if (error instanceof CimdFetchError) return errorPage('This app could not be verified.')
        throw error
      }
    },
  }
}

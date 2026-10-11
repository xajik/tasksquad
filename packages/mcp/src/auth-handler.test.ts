import { describe, expect, it, vi } from 'vitest'
import { callbackUrl, consentPage, createAuthHandler, escapeHtml, pkceChallenge, portalSignInUrl, randomVerifier } from './auth-handler.js'
import type { Env } from './env.js'

describe('auth handler helpers', () => {
  it('uses the RFC 7636 S256 challenge the worker verifies', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    // The worker accepts verifiers matching /^[A-Za-z0-9._~-]{43,128}$/.
    expect(randomVerifier()).toMatch(/^[A-Za-z0-9._~-]{43,128}$/)
  })

  it('builds the portal sign-in URL the /mobile/authorize page accepts', () => {
    const cb = callbackUrl('https://mcp.test/oauth/authorize?x=1')
    expect(cb).toBe('https://mcp.test/oauth/callback')
    const url = new URL(portalSignInUrl('https://portal.test', cb, 'c'.repeat(43), 's'.repeat(43)))
    expect(url.origin + url.pathname).toBe('https://portal.test/mobile/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe('https://mcp.test/oauth/callback')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('escapes client-controlled strings on the consent page', () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;')
    const html = consentPage({
      clientId: 'c1', clientName: '<script>alert(1)</script>', redirectUri: 'http://localhost:1/cb',
      redirectHost: 'localhost', redirectIsLoopback: true, scope: [],
    }, 'h"andle')
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('value="h&quot;andle"')
    expect(html).toContain('app on your computer')
  })
})

describe('callback', () => {
  const original = { responseType: 'code', clientId: 'c1', redirectUri: 'https://client/cb', scope: ['mcp'], state: 'st' }

  function setup(fetchImpl: typeof fetch) {
    const completeAuthorization = vi.fn(async () => ({ redirectTo: 'https://client/cb?code=xyz' }))
    const env = {
      API_BASE: 'https://api.test',
      PORTAL_BASE: 'https://portal.test',
      OAUTH_PROVIDER: {
        finishUpstream: vi.fn(async () => ({ request: original, data: { verifier: 'v'.repeat(64) }, headers: new Headers() })),
        completeAuthorization,
      },
    } as unknown as Env
    const handler = createAuthHandler(fetchImpl)
    return { env, handler, completeAuthorization }
  }

  it('exchanges the portal code and stores the API token in grant props', async () => {
    const fetchImpl = vi.fn(async (u: RequestInfo | URL, _init?: RequestInit) => String(u).endsWith('/exchange')
      ? Response.json({ token: 'tsq_cli_new', expires_at: 1 })
      : Response.json({ id: 'user1', email: 'u@test', plan: 'pro' }))
    const { env, handler, completeAuthorization } = setup(fetchImpl)
    const res = await handler.fetch!(new Request('https://mcp.test/oauth/callback?code=abc&state=s') as never, env, {} as ExecutionContext)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('https://client/cb?code=xyz')
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({ code: 'abc', code_verifier: 'v'.repeat(64), client: 'mcp' })
    expect(completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user1',
      props: { apiToken: 'tsq_cli_new', userId: 'user1', email: 'u@test' },
    }))
  })

  it('returns access_denied to the client when sign-in was abandoned', async () => {
    const { env, handler } = setup(vi.fn())
    const res = await handler.fetch!(new Request('https://mcp.test/oauth/callback?state=s&error=x') as never, env, {} as ExecutionContext)
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('Location')!)
    expect(loc.origin + loc.pathname).toBe('https://client/cb')
    expect(loc.searchParams.get('error')).toBe('access_denied')
    expect(loc.searchParams.get('state')).toBe('st')
  })

  it('renders an error page when the code exchange fails', async () => {
    const { env, handler, completeAuthorization } = setup(vi.fn(async () => Response.json({ error: 'invalid_authorization_code' }, { status: 401 })))
    const res = await handler.fetch!(new Request('https://mcp.test/oauth/callback?code=abc&state=s') as never, env, {} as ExecutionContext)
    expect(res.status).toBe(401)
    expect(completeAuthorization).not.toHaveBeenCalled()
  })
})

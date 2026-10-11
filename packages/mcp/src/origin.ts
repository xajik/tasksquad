import type { Env } from './env.js'

// Header the tasksquad.ai Pages middleware sets when it proxies /mcp, /oauth/*
// and /.well-known/oauth-* here (packages/portal/functions/_middleware.ts).
export const PUBLIC_HOST_HEADER = 'X-TSQ-Public-Host'

// The origin the client connected to: PUBLIC_URL, or a proxying alias listed in
// ALIAS_ORIGINS. Unlisted hosts fall back to PUBLIC_URL, so the header can only
// pick between origins we own.
export function publicOrigin(req: Request, env: Pick<Env, 'PUBLIC_URL' | 'ALIAS_ORIGINS'>): string {
  const host = req.headers.get(PUBLIC_HOST_HEADER)
  if (host) {
    const origin = `https://${host.toLowerCase()}`
    const aliases = (env.ALIAS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean)
    if (aliases.includes(origin)) return origin
  }
  return new URL(env.PUBLIC_URL).origin
}

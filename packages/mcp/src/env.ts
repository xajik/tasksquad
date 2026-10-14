import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

export interface Env {
  OAUTH_KV: KVNamespace
  // Injected by OAuthProvider into the default handler's env.
  OAUTH_PROVIDER: OAuthHelpers
  // Public origin of this worker; /mcp under it is the OAuth protected resource.
  PUBLIC_URL: string
  // Extra public origins that proxy here (comma-separated), e.g. https://tasksquad.ai
  ALIAS_ORIGINS?: string
  API_BASE: string
  // Service binding to the TaskSquad worker (tasksquad-api). API calls go through it rather
  // than the public internet, where the zone's security challenge blocks Worker traffic
  // (global_fetch_strictly_public sends every global fetch out publicly).
  API?: Fetcher
  PORTAL_BASE: string
}

// apiFetch calls the worker API through the service binding when it is bound.
export function apiFetch(env: Env): typeof fetch {
  const api = env.API
  return api ? (input, init) => api.fetch(input, init) : (input, init) => fetch(input, init)
}

// Props stored (encrypted) in the OAuth grant and handed to /mcp as ctx.props.
export interface Props {
  // tsq_cli_* token minted by the worker's /mobile/authorization/exchange.
  apiToken: string
  userId: string
  email: string
}

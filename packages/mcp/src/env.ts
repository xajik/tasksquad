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
  PORTAL_BASE: string
}

// Props stored (encrypted) in the OAuth grant and handed to /mcp as ctx.props.
export interface Props {
  // tsq_cli_* token minted by the worker's /mobile/authorization/exchange.
  apiToken: string
  userId: string
  email: string
}

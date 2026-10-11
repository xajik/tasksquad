import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { REFRESH_TOKEN_TTL, createAuthHandler } from './auth-handler.js'
import type { Env, Props } from './env.js'
import { publicOrigin } from './origin.js'
import { buildServer } from './server.js'

// Stateless Streamable HTTP: every request builds a fresh server bound to the
// caller's grant props, so no Durable Object or session state is needed.
const mcpHandler: ExportedHandler<Env> = {
  async fetch(req, env, ctx) {
    const props = (ctx as ExecutionContext & { props: Props }).props
    const server = buildServer(env, props)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(req)
  },
}

function createProvider(origin: string) {
  return new OAuthProvider<Env>({
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'TaskSquad' },
    apiRoute: '/mcp',
    apiHandler: mcpHandler as ExportedHandler<Env> & Pick<Required<ExportedHandler<Env>>, 'fetch'>,
    defaultHandler: createAuthHandler(),
    authorizeEndpoint: '/oauth/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    refreshTokenTTL: REFRESH_TOKEN_TTL,
  })
}

// The provider derives the issuer, metadata and callback URLs from the request
// origin and pins tokens to one resource, so each public origin gets its own
// provider and the request URL is rewritten onto that origin.
const providers = new Map<string, OAuthProvider<Env>>()
export default {
  fetch(req, env, ctx) {
    const origin = publicOrigin(req, env)
    let provider = providers.get(origin)
    if (!provider) providers.set(origin, provider = createProvider(origin))
    const url = new URL(req.url)
    const rewritten = url.origin === origin ? req : new Request(new URL(url.pathname + url.search, origin), req)
    return provider.fetch(rewritten, env, ctx)
  },
} satisfies ExportedHandler<Env>

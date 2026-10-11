import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/cloudflare-workers-stub.ts', import.meta.url)) },
  },
  // Inline the OAuth provider so the alias above applies to its import too.
  test: { server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } } },
})

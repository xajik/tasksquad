# TaskSquad Worker

The API backend for TaskSquad, running on Cloudflare Workers. It handles task routing, agent management, and live log streaming.

## Prerequisites

- Node.js (>= 20)
- npm

## Installation

```bash
cd packages/worker
bun install
```

## Development

Start the local development server (simulates Cloudflare environment):

```bash
bun run dev
```

The API will be available at `http://localhost:8787`.

## Test

Run the test suite using Vitest:

```bash
bun test
```

## Deployment

The worker is deployed to Cloudflare Workers automatically via GitHub Actions on push to `main` when files under `packages/worker/` change.

To deploy manually:

```bash
bun run deploy
```

This command uses `wrangler deploy` under the hood.

## Configuration

### Wrangler bindings (`wrangler.toml`)

| Binding | Type | Name | Description |
|---|---|---|---|
| `DB` | D1 | `tasksquad-db` | Primary database |
| `LOGS` | R2 | `tasksquad-logs` | Session log storage |
| `JWKS_CACHE` | KV | — | Firebase JWKS public-key cache |
| `AGENT_RELAY` | Durable Object | `AgentRelay` | Per-agent SSE relay |

### Secrets

Set via `npx wrangler secret put <KEY>`:

| Key | Description |
|---|---|
| `FIREBASE_PROJECT_ID` | Firebase project ID (e.g. `tasksquad-e1442`) |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Base64-encoded Firebase service account JSON |
| `DAEMON_SECRET` | Shared secret for `X-TSQ-Token` validation |

## Database migrations

D1 migrations live in `migrations/`. Apply to production with:

```bash
npx wrangler d1 migrations apply tasksquad-db
```

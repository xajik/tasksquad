# TaskSquad Worker

The API backend for TaskSquad, running on Cloudflare Workers. It handles task routing, agent management, and live log streaming.

## Prerequisites

- Node.js (>= 18)
- npm
- Wrangler CLI (`bun install -g wrangler`)

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

The worker is deployed to Cloudflare Workers automatically via GitHub Actions on push to `main`.

To deploy manually:

```bash
bun run deploy
```

This command uses `wrangler deploy` under the hood.

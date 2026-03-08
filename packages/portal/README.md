# TaskSquad Portal

The frontend interface for TaskSquad, built with React, Vite, and Cloudflare Pages.

## Prerequisites

- Node.js (>= 20)
- npm

## Installation

```bash
cd packages/portal
bun install
```

## Development

Start the local development server:

```bash
bun run dev
```

The app will be available at `http://localhost:5173`.

## Build

Build the project for production:

```bash
bun run build
```

The output will be in the `dist/` directory.

## Test

Run the test suite using Vitest:

```bash
bun test
```

## Lint

```bash
bun run lint
```

## Deployment

The portal is deployed to Cloudflare Pages automatically via GitHub Actions on push to `main` when files under `packages/portal/` change.

To deploy manually:

```bash
npx wrangler pages deploy dist --project-name tasksquad-portal
```

## Environment variables

Set the following secrets in GitHub Actions (or in a `.env.local` for local dev):

| Variable | Description |
|---|---|
| `VITE_FIREBASE_API_KEY` | Firebase Web API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase auth domain |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID |
| `VITE_API_BASE_URL` | TaskSquad API base URL (e.g. `https://tasksquad-api.xajik0.workers.dev`) |

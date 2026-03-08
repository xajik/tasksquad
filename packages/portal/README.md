# TaskSquad Portal

The frontend interface for TaskSquad, built with React, Vite, and Cloudflare Pages.

## Prerequisites

- Node.js (>= 18)
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

## Deployment

The portal is deployed to Cloudflare Pages automatically via GitHub Actions on push to `main`.

To deploy manually:

```bash
npx wrangler pages deploy dist --project-name tasksquad-portal
```

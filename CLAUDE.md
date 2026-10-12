# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# TaskSquad

Coordination layer for teams of humans and AI agents. Agents run as a local daemon on user machines, execute tasks via a configured CLI (Claude Code, Codex, Gemini, OpenCode, Claw, Pi, or any stdout-based tool), and stream results to a cloud API. Humans work through an email-style inbox on the web, iOS, or macOS clients.

## Products and repo layout

```
packages/
  daemon/   Go — `tsq`, the daemon users install (CLI + Go macOS menu-bar app). Linux/production reference implementation.
  worker/   TypeScript — Cloudflare Worker API (D1, R2, KV, Durable Objects). Every client talks to this.
  mcp/      TypeScript — remote MCP server (Cloudflare Worker + OAuth) exposing the portal's capabilities to AI agents; proxies to worker/
  portal/   TypeScript/React — web portal at tasksquad.ai (Vite + Tailwind v4 + shadcn/Radix, Cloudflare Pages)
  macos/    Swift — native macOS app = daemon engine + portal UI in one process ("TaskSquad Native.app")
  ios/      Swift — iOS portal app (XcodeGen project; no daemon)
  mobile/TaskSquadPortal/  Swift package shared by ios/ and macos/: portal API client, workspace store, terminal session
```

How the pieces relate:

- **Two daemons.** `packages/daemon` (Go) is the shipping daemon and the compatibility oracle. `packages/macos` is an independent Swift reimplementation of the daemon (`TaskSquadCore`: engine, polling, providers, tmux, credentials, crypto) **plus** a native portal UI (`TaskSquad` target: `Customer*.swift` files mirror the web portal's sections). It is still work in progress — see `packages/macos/COMPATIBILITY.md` for parity gates. Do not retire or diverge from Go behaviour based on the Swift build.
- **Both daemons share on-disk state**: `~/.tasksquad/config.toml`, `device-id`, `daemon.lock` (BSD `flock`, never unlink it), `logs/`, `tasks/`, and the login Keychain service `tasksquad-daemon`. Swift must write values the Go daemon can read. `make test-compatibility` builds `macos/Tests/GoReference` against the real Go config/crypto packages to verify this.
- **MCP server** (`packages/mcp`) is a fourth client of the worker API, for agents. OAuth sign-in reuses the mobile PKCE flow: the portal's `/mobile/authorize` page plus `/mobile/authorization/{codes,exchange}`, with redirect URIs allowlisted by the worker's `MCP_REDIRECT_URIS` and the portal's `MobileAuth.tsx`. Also served at `tasksquad.ai/mcp`: the portal's Pages middleware proxies `/mcp`, `/oauth/*` and `/.well-known/oauth-*` to it (`ALIAS_ORIGINS`). Destructive, membership and credential actions are registered as tools that always return "user needs to take this action manually" (`src/tools/blocked.ts`). `src/api.ts` mirrors `portal/src/lib/api.ts`.
- **Three portal clients** — web (`portal/`), macOS (`macos/Sources/TaskSquad/Customer*`), iOS (`ios/`) — all hit the same worker API. The two Swift clients share `mobile/TaskSquadPortal` (both `packages/ios/project.yml` and `packages/macos/Package.swift` reference it by path), so changes there affect both apps. The package has three products — `TaskSquadPortal` (API, stores, policy), `TaskSquadDesign` (tokens, icons) and `TaskSquadPortalUI` (shared SwiftUI). The iOS/macOS unification is in progress; `packages/mobile/TaskSquadPortal/MIGRATION.md` tracks status and resume steps.
- **`DESIGN.md`** at the repo root is the shared design spec (colors, type, spacing, radius, light + dark themes) for every UI. Web tokens live in `portal/src/index.css`; macOS tokens in `macos/Sources/TaskSquad/Design/Theme.swift`.

## Commands

```bash
make test                      # root: daemon + portal + worker; macos test-compatibility too on Darwin
make bump [minor|major]        # bump every product's version (patch default) — scripts/bump.py

# Go daemon (packages/daemon)
make dev                       # air hot-reload
make build                     # go build -o tsq .
make test                      # CGO_ENABLED=0 go test ./...
go test ./agent -run TestName  # single test

# Worker (packages/worker)
bun run dev                    # wrangler dev --local
bun run build                  # wrangler deploy --dry-run (CI "build")
bun run test                   # vitest;  bunx vitest run src/routes/memory.test.ts -t "name" for one test
make migrate-local | make migrate          # apply D1 migrations local | production
make new-migration name=add_something

# MCP server (packages/mcp)
make dev | make test | make build   # wrangler dev :8788 | vitest | tsc + dry-run deploy

# Web portal (packages/portal)
bun run dev                    # vite, localhost:5173
bun run build                  # SEO manifest + tsc -b + vite build — fails hard on any TS error
bun run test | bun run lint

# macOS native (packages/macos) — Darwin only; minimum macOS 26, latest Xcode/Swift (swift-tools 6.4)
make build | make dev          # swift build / run debug binary
make test                      # swift test;  swift test --filter TestClassName for one
make test-compatibility        # builds Go reference oracle, then Swift tests
make test-ui                   # offscreen UI renders → .build/ui-artifacts/
make app-check | make install  # universal .app + checks | install ~/Applications/TaskSquad Native.app
make cli | make install-cli    # standalone tsq tarball (CLI + headless daemon) | link the app's tsq into ~/.local/bin

# iOS portal (packages/ios) — needs xcodegen; project file is generated
make build | make test         # xcodegen generate + xcodebuild on iPhone 17 Pro / iOS 26.1 simulator
make e2e-contract              # starts scripts/workspace_fixture.py on :18743, runs UI tests against it

# Shared Swift package (packages/mobile/TaskSquadPortal)
swift test
```

## Deploys

GitHub Actions, gated by path filters — a commit only triggers workflows for packages it touches:

- **Worker** (`deploy-worker.yml`, push to `main` on `packages/worker/**`) → `wrangler deploy`. Apply D1 migrations (`make migrate`) **before** pushing worker code that depends on them.
- **MCP** (`deploy-mcp.yml`, push to `main` on `packages/mcp/**`) → `wrangler deploy` of `tasksquad-mcp`. Needs the worker's `MCP_REDIRECT_URIS` and the portal allowlist deployed first.
- **Portal** (`portal.yml`, `packages/portal/**`) → build then `wrangler pages deploy`. **Any TypeScript error fails the deploy silently** — the site keeps serving the previous build. Always run `bun run build` locally before trusting a portal change is live.
- **Go daemon** (`daemon.yml`) → GoReleaser on `v*` tag push only. Merging to `main` does not reach installed `tsq` binaries until a tag is cut.
- **macOS native** (`macos-native.yml` on PR/push for `packages/macos/**` or `packages/daemon/**`; preview/stable are manual `workflow_dispatch` with `X.Y.Z-preview.N` / `X.Y.Z`) → separate `macos-v*` releases. They never touch Go `v*` releases or the Homebrew cask.
- **iOS** has no CI deploy.

## Architecture facts worth knowing before touching daemon↔worker↔client code

- **The daemon polls; nothing pushes to it.** Heartbeats hit `/daemon/heartbeat/batch` every `poll_interval` (default 60s). It learns about new work on the next poll.
- **The web portal polls too** (`setInterval`, 2s Pro / 5s free) for task/message updates. There is no SSE in the task flow.
- **Task execution**: daemon spawns the provider CLI in a named tmux session (falls back to PTY without tmux), reads output via `tmux pipe-pane` → FIFO, detects completion via provider HTTP hooks (preferred) or process exit, then `POST /daemon/session/close` and uploads the log to R2 via presigned URL.
- **Live terminal output streams over WebSocket**, not polling: `daemon/agent/terminal_relay.go` dials `worker/src/terminal/relay.ts` (`TerminalRelay` Durable Object), which fans out raw PTY bytes to viewers (xterm.js on web, SwiftTerm on iOS/macOS). Regular tasks (`lifecycle.go`) and Portals (`portal.go`) share the same relay and DO class.
- **Auth header split**: daemon requests carry `Authorization: Bearer <token>` (90-day `tsq_cli_*` token or a Firebase ID token — `withFirebaseAuth` in `worker/src/auth.ts` accepts either) **and** `X-TSQ-Agent: <agentID>`. Both are required for every `daemonRoute`-wrapped endpoint, including the WebSocket upgrade. Mobile clients sign in via browser + PKCE code exchange (`MobileAuthFlow.swift`, `PortalAPI.swift`).
- **Portals** (`daemon/agent/portal.go`, `worker/src/routes/portals.ts`, `portal/src/pages/Portals.tsx`) open a bare interactive tmux session streamed to the client. Pro-only, max 3 concurrent per team. Session name `tsq-portal-<first8CharsOfID>` — the prefix matters (see orphan sweep below).

## Gotchas discovered the hard way

- **`addCors()` in `worker/src/index.ts` must not rebuild WebSocket-upgrade responses.** `new Response(res.body, …)` silently drops Cloudflare's `webSocket` property, breaking every WS upgrade while still returning a successful-looking 101 (daemon sees `websocket: bad handshake`, no server error). It short-circuits on `res.webSocket`; keep that guard when touching `addCors` or adding WS routes.
- **FIFO reads for `pipe-pane` must not stay `O_NONBLOCK` once a writer connects.** `portal.go` opens non-blocking only to bound the wait for the writer; afterwards an idle pane makes `Read()` return `EAGAIN`, which looks like the session ended. Call `syscall.SetNonblock(fd, false)` — `os.File.Fd()` alone does not reliably do this.
- **The orphan sweep (`daemon/orphan/orphan.go`, on startup + hourly) kills any `tsq-*` tmux session not in the `sessions` table.** Portal (`tsq-portal-*`) and supervisor (`tsq-sup-*`) sessions are explicitly excluded. Any new tmux naming pattern needs the same exclusion or its own state lookup. The Swift engine shares tmux and lock files, so keep naming consistent across both daemons.
- **Portal PWA precache limit is 2 MiB** (`vite-plugin-pwa` `injectManifest.maximumFileSizeToCacheInBytes`). A big dependency can fail `vite build` *after* `tsc` passed.
- **Lockfiles**: `bun.lock` at the root and `package-lock.json` in several packages coexist. CI uses `bun install`; don't assume they're in sync.
- **macOS native and Go must interoperate**: the Swift config editor edits the same `config.toml` text in place (preserving comments/unknown fields) rather than regenerating it; Keychain values must stay Go-readable. Managed tmux input/close from the Swift UI goes through the Go daemon's `/hooks/terminal/input` and `/hooks/terminal/close` endpoints.
- **iOS project file is generated** — edit `packages/ios/project.yml`, not `TaskSquad.xcodeproj` (`make clean` deletes it).

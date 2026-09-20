# TaskSquad

Coordination layer for teams of humans and AI agents. Agents run as a local daemon (`tsq`) on
user machines, execute tasks via a configured CLI (Claude Code, Codex, Gemini, OpenCode, Pi, or
any stdout-based tool), and stream results to a cloud-hosted portal through an email-style inbox.

## Repo layout

```
packages/
  daemon/   Go — the `tsq` binary users install locally
  worker/   TypeScript — Cloudflare Worker API (D1, R2, KV, Durable Objects)
  portal/   TypeScript/React — the web app at tasksquad.ai (Vite + Cloudflare Pages)
```

Each package is independently deployed and has its own `Makefile` (`make build|test|dev|deploy`).
The root `Makefile` just fans out `make test` to all three. There is no shared build step —
changes to one package don't require touching the others unless the API contract between them
changes.

## Commands

```bash
make test                              # from repo root: runs daemon + portal + worker tests

cd packages/daemon && make dev         # air hot-reload — rebuilds+restarts tsq on save
cd packages/daemon && make build       # go build -o tsq .
cd packages/daemon && go test ./...

cd packages/worker && bun run dev      # wrangler dev --local
cd packages/worker && bun run build    # wrangler deploy --dry-run (this is what CI runs as "build")
cd packages/worker && bun run test     # vitest

cd packages/portal && bun run dev      # vite dev server, localhost:5173
cd packages/portal && bun run build    # tsc -b && vite build — fails hard on any TS error
cd packages/portal && bun run test     # vitest
```

## Deploys

All three deploy via GitHub Actions on push to `main`, gated by path filters — a commit only
triggers the workflow(s) for the package(s) it touches:

- **Deploy Worker** (`packages/worker/**`) → `wrangler deploy` to Cloudflare Workers. Fast,
  usually done within a minute of push.
- **Deploy Portal** (`packages/portal/**`) → `tsc -b && vite build` then `wrangler pages deploy`
  to Cloudflare Pages. **Any TypeScript error fails the whole deploy silently** (no PR gate
  catches it unless a PR was opened) — the site just keeps serving the previous build. Always
  run `bun run build` locally before trusting that a portal change is live.
- **Release Daemon** (`packages/daemon/**`, tag push `v*` only) → GoReleaser. Unlike the other
  two, this does **not** fire on merge to `main` — it needs an explicit version tag. A fix merged
  to `main` does not reach any installed `tsq` binary until a new tag is cut and users update.

## Architecture facts worth knowing before touching daemon↔worker↔portal code

- **The daemon polls; nothing pushes to it.** Heartbeats hit `/daemon/heartbeat/batch` on an
  interval (`poll_interval` in config, default 60s). There is no SSE or webhook notifying the
  daemon of new work — it finds out on its next poll.
- **The portal polls too**, not SSE, for task/message updates (`setInterval`, 2s for Pro / 5s
  free). SSE genuinely exists in this codebase, but only for the Voice-to-Markdown feature
  (`packages/daemon/speechtomd`) — don't assume it's used for the main task flow.
- **Live terminal output (both regular task sessions and Portals) streams over a WebSocket**,
  not polling: `packages/daemon/agent/terminal_relay.go` dials
  `packages/worker/src/terminal/relay.ts` (a `TerminalRelay` Durable Object), which fans out raw
  PTY bytes to browser viewers rendering via `xterm.js`. Regular tasks and Portals share this
  same relay and DO class — the daemon just dials it from two call sites
  (`lifecycle.go` for tasks, `portal.go` for Portals).
- **Auth header split**: daemon requests carry `Authorization: Bearer <token>` (either a 90-day
  `tsq_cli_*` token or a short-lived Firebase ID token — `withFirebaseAuth` in `auth.ts` accepts
  either) *and* `X-TSQ-Agent: <agentID>` identifying which agent the request is scoped to. Both
  headers are required together for any `daemonRoute`-wrapped endpoint, including the WebSocket
  upgrade route.
- **Portals** (`packages/daemon/agent/portal.go`, `packages/worker/src/routes/portals.ts`,
  `packages/portal/src/pages/Portals.tsx`) open a bare interactive tmux session (no task, no
  prompt) and stream it to the browser. Pro-only, capped at 3 concurrent per team. A portal's
  tmux session is named `tsq-portal-<first8CharsOfID>` — this prefix matters, see gotchas below.

## Gotchas discovered the hard way (read before debugging similar symptoms)

- **`addCors()` in `packages/worker/src/index.ts` must not rebuild WebSocket-upgrade responses.**
  The top-level `fetch` handler wraps every response through `addCors`, which used to do
  `new Response(res.body, { status, headers })` unconditionally — that constructor silently
  drops Cloudflare's `webSocket` property, breaking every WS upgrade (browser and daemon alike)
  while still returning a "successful-looking" 101. Symptom was `websocket: bad handshake` on
  the daemon side with no server-side error at all. Fixed by short-circuiting on
  `res.webSocket` truthy. If you touch `addCors` or add new WebSocket routes, keep this guard.
- **FIFO reads for tmux `pipe-pane` output must not stay `O_NONBLOCK` once a writer is
  connected.** `packages/daemon/agent/portal.go` opens the FIFO non-blocking only to bound the
  wait for `pipe-pane`'s writer to show up; leaving it non-blocking after that makes every
  `Read()` on an idle-but-open pane return `EAGAIN` (`resource temporarily unavailable`) instead
  of blocking for the next chunk, which looks exactly like the session ending. Call
  `syscall.SetNonblock(fd, false)` once a writer is confirmed connected — `os.File.Fd()` alone
  does **not** reliably do this for a caller-opened `O_NONBLOCK` fd, verified empirically.
- **The orphan-sweep in `packages/daemon/orphan/orphan.go` runs on daemon startup + hourly and
  kills any `tsq-*` tmux session whose ID isn't found in the `sessions` table.** Portal sessions
  (`tsq-portal-*`) live in the `portals` table instead, so without an explicit exclusion they get
  killed as false orphans within seconds of starting — the relay would connect successfully and
  then the tmux session would die underneath it. Same treatment `tsq-sup-*` (supervisor sessions)
  already gets. Any new tmux-session-naming pattern needs the same exclusion or its own state
  lookup.
- **The portal bundle's PWA service worker has a 2 MiB precache limit by default** (`vite-plugin-
  pwa`'s `injectManifest.maximumFileSizeToCacheInBytes`). Adding a sizeable dependency (e.g.
  `@xterm/xterm`) can push the main chunk over that limit and fail the build at the `vite build`
  step *after* `tsc` already passed — a different failure mode than a TS error, easy to miss if
  you only check `tsc`.
- **Lockfiles**: the repo has both `bun.lock` (workspace root) and `package-lock.json` files
  sitting alongside each other in several packages. CI uses `bun install`, which resolves fresh
  regardless of a stale `package-lock.json`, but don't assume the two are in sync.

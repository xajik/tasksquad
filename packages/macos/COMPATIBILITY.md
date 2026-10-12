# Compatibility completion ledger

Objective: one native Swift macOS app, with the full observable behavior of the existing Go daemon, the same storage/configuration, the complete native local control panel, release pipelines, local installation, and end-to-end verification. No embedded Go engine, web control panel or separate helper daemon.

**Parity first (decided 2026-10-11).** Swift must reach full Go parity on macOS before anything else. Whether Swift later replaces Go on Linux and Windows is decided only after every row of the parity matrix below is E2E-verified; until then Go remains the daemon for Linux and Windows and no Swift Linux/Windows target is added. Avoid new Apple-only dependencies in `TaskSquadCore` when a Foundation/POSIX equivalent is equally simple, so that decision stays open.

Reference inspected: `fb06dad4bab233cb3b614ca036a420a2bcb0c115`. Tests build their oracle from the current Go tree, so Go changes can reveal drift. Test successes below prove only their listed scope; they do not establish overall compatibility.

## Implemented and verified

- [x] Swift 6 package builds a native SwiftUI/AppKit app without external runtime dependencies.
- [x] Both arm64 and x86_64 release slices build and combine into one executable.
- [x] Existing TOML schema/defaults pass shared valid/invalid fixtures against Go.
- [x] Directory-based config observation handles atomic editor replacement.
- [x] Existing device ID/path conventions and mutually exclusive Go/Swift BSD file locks.
- [x] Keychain value codecs match Go's raw, hex, and base64 formats (codec tests, not real-account access).
- [x] Isolated native login-Keychain integration: Go reads Swift-created entries; Swift reads Go updates; test service removed afterward.
- [x] Authentication tests cover token priority, expiry, refresh, fallback, forced rotation and concurrent refresh sharing.
- [x] Real native local HTTP requests, split framing, chunked bodies, limits and occupied-port failures.
- [x] Existing portal login callback protocol, timeout and cancellation using a local listener.
- [x] Go and Swift decrypt each other's AES-GCM payloads for supported AES key lengths.
- [x] Agent/supervisor configuration display, raw TOML editor, bounded log/journal reader build.
- [x] Engine start/stop and live native session state; shared lock acquired before polling and released after cleanup. UI interaction itself still awaits inspection.
- [x] Heartbeat policy and native transport tests: initial poll, ETag, hints, forced poll, 429 backoff and one 401 rotation/retry.
- [x] Agent mode transition table and stale-generation/duplicate-notification guards tested in isolation.
- [x] Native process byte fidelity, large stdin/stdout, environment/cwd, separate stderr, process-group cancellation and descendants after launcher exit.
- [x] Full isolated stdout task cycle over real local HTTP: session open, process, JSONL/run logs, close, AES-GCM upload and attach.
- [x] Stdout process failure, shutdown output drain and server-initiated close without duplicate final reply.
- [x] Universal bundle checks, development local installation, and DMG packaging run successfully.
- [x] CI and signed-preview workflow syntax validated with actionlint.

## Native workspace usability (2026-09-21)

- [x] Startup account display no longer blocks the main thread on Keychain authorization; isolated UI tests skip real-account lookup.
- [x] Live agent observation, status clearing on disconnect, and native Stop Task cleanup.
- [x] Sidebar/activity layout; native Markdown previews in light/dark mode; searchable JSON tree preserving large numbers; searchable colored logs.
- [x] tmux discovery, control connection, ANSI styles/Unicode, keyboard/IME, input, size updates, history, detach and session close.
- [x] Isolated real tmux tests cover full-screen alternate-screen TUI keyboard/mouse/resize, daemon pipe preservation, and unrelated-session survival.
- [x] Native UI model tests cover attach, live screen updates, input, history input gating, detach, reattach and close.
- [x] Component renders generated and inspected; JSON width/contrast corrected from that inspection.
- [x] Installed-app file picker, Markdown/source views, JSON expansion/search/exact numbers/live refresh, log filtering, terminal keyboard/Unicode input, Fit/history, detach/reattach and destructive close confirmation exercised through Computer Use.
- [ ] Remaining desktop checks: window/menu lifetime, window resizing, both appearances, and sustained production-provider interaction.
- [x] A 12,000-line burst and repeated pane switching preserve input destination, bounded visible screens, and clean client detachment.
- [ ] Representative real provider sessions and sustained desktop interaction.

## Go → Swift parity matrix

Status: **missing** (no Swift implementation), **partial** (some behaviour or tests absent), **done** (ported Go behaviour + Swift tests pass), **E2E** (also verified in a real differential run against Go). Go is the oracle; port its `_test.go` cases with each feature. Snapshot taken from source on 2026-10-11.

### Engine

| Go reference | Swift | Tests | Status | Remaining |
|---|---|---|---|---|
| `config` (TOML schema, defaults) | `Configuration.swift`, `TOML.swift` | `ConfigurationTests`, `GoCompatibilityTests`, `TOMLConformanceTests` (44-document corpus: number forms, dotted/inline/quoted keys, multiline and escaped strings, duplicates, redefinitions, wrong types, malformed input — accept/reject and values identical to Go) | done | — |
| device-id, `daemon.lock` (`app_darwin.go`) | `Paths.swift` | `StorageTests`, `GoCompatibilityTests` | done | — |
| `auth` (token priority, refresh, logout) | `Authentication.swift`, `LoginFlow.swift` | `AuthenticationTests`, `LoginFlowTests` | partial | Real-account Keychain reuse incl. OS authorization of the new executable |
| Keychain (`go-keyring`) | `Credentials.swift` | `KeychainIntegrationTests` (optional) | done | — |
| AES-GCM upload crypto | `Encryption.swift`, `ArtifactUploader.swift` | `GoCompatibilityTests`, `EngineIntegrationTests` | done | — |
| `agent/batch.go` heartbeat polling | `BatchPoller.swift` | `BatchPollerTests` (backoff 30s→5m, ETag/304, 401 rotate+retry, coalesced force-polls, restart, failure analytics) | done | Responses matched by `agent_id` (the Worker always sends it) rather than Go's positional match; real-Worker check is part of the E2E qualification |
| `agent/state.go`, `agentmode` | `AgentState.swift` | `AgentStateTests`, `AgentStateGoldenTests` (all 36 mode×event transitions and error text dumped from Go) | done | — |
| `agent/lifecycle.go`, `session.go`, `complete.go` (tmux + FIFO execution) | `DaemonEngine.swift`, `TmuxTaskSession.swift`, `NativeProcess.swift` | `InteractiveEngineTests` (incl. ports of `spawn_failure_test`, `terminal_control_test`), `LateReplyTests` (late paused reply vs replacement session), `EngineIntegrationTests`, `TmuxIntegrationTests`, `AgentPureGoldenTests` (`lifecycle_test` prompt/KB cases) | done | Close sequence: `CloseSequenceTests` (order, empty steps dropped, `close_step_idx`, user close ignored while wrapping up) |
| `agent/terminal_control.go` managed input/close | `DaemonEngine.handleTerminal`, `ManagedTerminal.swift` | `ManagedTerminalTests`, `InteractiveEngineTests.testManagedTerminalTwoTurnsAndScopedClose` (port of the Go test) | done | — |
| `agent/terminal_relay.go` WebSocket relay | `TerminalRelay` (in `PortalHost.swift`), `DaemonEngine` | `InteractiveEngineTests.testTaskStreamsToRelayAndGatesBrowserInputOnTUIBlocked` | done | Tasks and Portals share it: raw bytes out (tmux and pipe), daemon auth headers, input gated on TUI-blocked (Codex always), resize always. Like Go, no reconnect after a drop |
| `agent/portal.go` Portals | `PortalHost.swift` | `PortalHostTests`, `PortalBehaviourTests` (close_now, crash recovery failed/done, shutdown close) | done | Go waits a fixed 15s before streaming a new Portal; Swift streams as soon as the FIFO opens |
| `agent/inbound_images.go` | `InboundAttachments.swift` | `InboundAttachmentsTests` | done | — |
| `agent/transcript.go`, `adapter/*` extraction | `HookAdapter.extractTranscript`, `DaemonEngine.finalText` | `AgentPureGoldenTests` (every provider × sample transcript vs Go) | done | — |
| `agent/lifecycle.go` prompt + KB note, `output.go` cleanLine | `TaskPrompt`, `DaemonEngine.injectKBNote`, `TaskOutput.cleanLine` | `AgentPureGoldenTests` | done | KB note now uses Go's regular-file `kb.Exists` rule |
| `adapter/*`, `provider/*` (Claude, Codex, Gemini, OpenCode, Pi, Claw, stdout) | `Providers.swift`, `ProviderTemplates.swift` (generated by `scripts/gen-provider-templates.py`) | `ProviderTests`, `ProviderGoldenTests` (Go oracle: args, env, every generated file) | done | Real-provider E2E (workstream F) |
| `metrics/lifecycle.go`, `codex_lifecycle.go`, `report.go` | `SessionLifecycle.swift`, `SessionReport.swift` | `SessionLifecycleTests`, `SessionReportTests` | done | — |
| `harness` reconcile, `skills`, `agents`, `commands` sync | `ResourceSync.swift` | `ResourceSyncTests`, `ResourceSyncGoldenTests` (two-phase install/update/remove: every harness file, Codex variants and lock contents identical to Go's sync) | done | **Go security bug, not replicated:** Go installs a server-supplied skill name verbatim as a path, so `../escape` writes `.claude/escape/SKILL.md` and `.tsq/escape/SKILL.md` outside the skills folders (more `../` reaches further); Swift rejects unsafe names |
| `upload` | `ArtifactUploader.swift` | `EngineIntegrationTests` | done | — |
| `memory`, `kb` storage/search | `LocalKnowledge.swift` | `CLIGoldenTests` | done | — |
| `memory`, `kb` close-step learning | `DaemonEngine` close sequence | `CloseSequenceTests` | done | Fixed: a server `close` during wrapping_up cancelled the sequence; Go only honours it while running/waiting_input |
| `orphan` sweep (startup + hourly) | `OrphanSweep.swift` | `OrphanSweepTests` | done | A response without `states` is a failed lookup (Go would kill every session) |
| `supervisor` (`tsq-sup-*`) | `Supervisor.swift` | `SupervisorTests` (incl. byte-golden vs Go `buildContextBlock`/`printModeCmd`) | done | Screenshot snapshot + closing attachment and analytics wired. Go bugs kept for parity: `CancelForTask` kills `tsq-sup-<first 8>` (never the real session), and the `PATH=… cat … \| cli` prefix only reaches `cat`, not the CLI |
| `dreamer` | `Dreamer.swift`, `GoRand.swift` (generated by `scripts/gen-go-rand.py`) | `DreamerTests` (golden: Go `triggerTime` + `math/rand` sequence) | done | Same random nightly moment as Go per agent/date, claim, rollup, `tsq-dream-*` session, last-run marker. `tsq kb init` command still open (engine side: `Dreamer.startKBInit`). Go uses one startup token for the night (expires after ~1h); Swift refreshes per call |
| `analytics` | `Analytics.swift` | `AnalyticsTests`, `EngineIntegrationTests` | done | Same events/properties and payload as Go. Go bug kept for parity: the Amplitude batch body is a bare array without `api_key`, which Amplitude rejects. `user_login`/`user_logout`/`$identify` move with the CLI auth commands |
| `screenshot` | `TerminalScreenshot.swift` (CoreGraphics/CoreText, embedded JetBrains Mono) | `TerminalScreenshotTests` | done | Same grid parser, palette and 10×22 cells, so images have Go's exact dimensions; glyph rasterization differs. `tsq screenshot` command still open |
| `tasklog`, `logger` | `TaskHistory.swift`, `TaskOutput.swift`, `RunArtifacts.swift`, `DaemonRunner.DaemonLog` | `StorageTests`, `TaskLogGoldenTests` (journal lines byte-identical to Go's `tasklog`), `CLIGoldenTests.testLogs` | done | Fixed: journal `ts` was UTC with random field order, `agent_turn` always wrote an empty `transcript_path`, and `task_end` lacked `r2_log_key` |

### Local hook routes (`daemon/hooks`)

| Route | Status |
|---|---|
| `/hooks/stop`, `/hooks/notification`, `/hooks/after_agent`, `/hooks/codex`, `/hooks/opencode`, `/hooks/skill`, `/hooks/tui-blocked`, `/hooks/terminal/input`, `/hooks/terminal/close` | done: `HookParseGoldenTests` (every adapter's ParseStop vs Go), Codex title-turn/duplicate/stale routing and Pi stop semantics in `InteractiveEngineTests`. Fixed: Codex title-generation turn was accepted, failure stops dropped the provider's error text, empty Pi stops completed as closed |
| `/hooks/attach` (used by `tsq send-image`) | done (`InteractiveEngineTests.testAttachHookSendsImageForCurrentTaskOnly`) |
| Hook listener always on (stdout-only configs too) | done; deliberate difference: a busy port fails start instead of Go's silent goroutine error |
| `/hooks/event` | done (`InteractiveEngineTests.testEventHookFeedsCurrentTaskLifecycleIntoSessionReport`) |
| `/hooks/supervisor`, `/hooks/trigger-supervisor` | done (validation + 409/503 contract in `InteractiveEngineTests`) |

### `tsq` CLI (`daemon/main.go`, `daemon/cmd`, `daemon/commands`)

Output text and exit codes must match Go byte-for-byte: agents and skills parse them. `TaskSquadCLI` (the app binary dispatches these before any UI) is verified by `CLIGoldenTests`, which runs the real Go `tsq` (built by `make test-compatibility`) and Swift on the same argv, HOME and isolated tmux server.

| Command | Status |
|---|---|
| `login`, `logout`, `init` | done in `TaskSquadCLI` (`CLIAuthTests`: Go's prompts, `Scanln` first-word answers, config text and 0600 mode). Browser sign-in can't run against the Go binary |
| `--version` / `-version` | done (golden, `tsq` daemon entry) |
| `sessions`, `attach`, `pane`, `send` | done (`CLIGoldenTests`: byte-identical stdout/stderr/exit vs the Go binary) |
| `logs` | done (golden) |
| `screenshot` | done (golden for output and errors; PNG pixels differ by rasterizer) |
| `report`, `skill`, `send-image` | done (golden, incl. Go flag errors and `-h`; identical request bodies). Connection-refused error text differs from Go's net/http wording |
| `memory`, `kb`, `tags` | done: offline paths golden (`testMemoryKBAndTagsOffline`: local push/search, kb search, usage and config errors); cloud paths in `CLINetworkTests` (Go reads the real Keychain, so they can't run against the Go binary) |
| `projects`, `agents`, `tasks`, `portals`, `resources`, `doctor` | done: argument errors, config errors and `doctor` golden vs Go; API behaviour (number-literal JSON, sorted keys, escaping, redaction, project scoping, `wait` exit 3, no redirects) in `CustomerCommandTests` |

### macOS app lifecycle

| Go reference | Status | Remaining |
|---|---|---|
| `autostart` (login item) | done | Same `ai.tasksquad.tsq` LaunchAgent plist as Go (byte-golden), first-run enable marker, menu toggle; either app takes over the other's registration |
| `ui/power_darwin.go` wake lock | done | `caffeinate -i` while pulling, released on pause/stop (also ends with the app) |
| Finder/login PATH propagation | done (golden); launch E2E in qualification | `TaskSquadPaths.searchPath` equals Go `appSearchPath` (incl. `~/.opencode/bin`) plus Node version-manager folders; `needsSearchPath` mirrors `prepareAppEnvironment` (app bundle always, plain `tsq` only under launchd). `StorageTests.testSearchPathMatchesGoAppSearchPath`. Real Finder/login-item launch still to be checked on a clean machine |
| Automatic engine start, graceful quit/drain | done | Engine starts at launch when configured; with no config the app opens `tsq init` in Terminal and relaunches (Go `startAppSetup`) |
| Menu: email, live stats, Pause/Resume Pulling, Run on OS Boot, Open Config, Logout | done | Deliberate difference: Go's pause flag is never read by its poller, so pausing does not stop task pickup there; Swift stops new pickup while heartbeats continue |
| Go ↔ Swift switching after drain | done (offline differential); production E2E in qualification | `DaemonSwitchingTests`: the Go oracle `daemon` mode (Go's hook server + `RunBatch`, in-memory keyring) finishes task A, is killed, then Swift starts on the same HOME and claims only task B; each side is refused while the other holds `daemon.lock`; `device-id`, the task journal and close status carry over. Dreamer `last-run` and resource-sync lock files use Go's paths. Intentional divergence: Go's tray Quit (and SIGTERM, which it does not handle) leaves running task sessions stranded with no adoption on restart; Swift cancels them and closes them as crashed. Real-Keychain credential reuse is the open auth row |

### Distribution

| Go | Swift | Status |
|---|---|---|
| `tsq` binary (CLI + headless daemon, GoReleaser archives) | `tsq` executable target (no AppKit/SwiftUI): subcommands via `TaskSquadCLI`, no subcommand runs `DaemonRunner` (daemon log, wake lock, first-run autostart, SIGINT/SIGTERM drain); `make cli` → `tsq_Darwin_universal.tar.gz`, signed and notarized by the stable workflow | done (golden: daemon flags, `-h`, config errors) |
| Tray app (`TaskSquad.app`, Homebrew cask) | `TaskSquad Native.app` with `Contents/MacOS/tsq` beside the app binary; `make install-cli` links it onto PATH | done; Homebrew cask switch waits for cut-over |

### Qualification (exit criteria for the migration decision)

- [ ] Differential E2E, Go then Swift, on the Pi agent: task → waiting_input → reply → done; deliberate close; crash; attachments in/out; Portal open/close; web live terminal; supervisor trigger; daemon switching.
- [ ] Real Claude Code and Codex runs with Unicode input.
- [ ] Native setup, Agents, Supervisor, Sessions, Tasks, Logs and Tools UI parity; no inert placeholder controls.
- [x] Platform floor: macOS 26 and the latest Xcode/Swift; swift-tools 6.2 (the first with `.v26`) so the newest stable Xcode on hosted `macos-26` (26.6 / Swift 6.3 as of Oct 2026) builds it. The app stays universal (macOS 26 still runs on some Intel Macs), but hosted CI has no Intel macOS 26 runner, so x86_64 is built, not run.
- [ ] Developer ID signing, notarization, Gatekeeper and clean-machine install.
- [ ] Remote CI green; signed draft release validated. CI: `Native macOS` validate + intel green since `c65b1fb`. Signed draft release not yet run.

## Evidence and next work

### Implementation checkpoint (2026-10-10)

This checkpoint records source-level progress separately from installed production evidence:

- Implemented native managed-terminal ownership from daemon snapshots, waiting-input bookkeeping for Return submissions, a drain-before-restart path, attachment materialization for initial tasks and replies, and repair of missing provider resource copies when ETags are unchanged.
- Corrected Inbox origin/schedule filters and moved notification polling to the workspace model so notifications continue outside the Inbox view. Added a customer CLI for project/agent/task/Portal operations, resource audit/sync, and doctor checks; cloud commands use user authentication without the daemon agent header.
- Added a versioned generic default-resource catalog, project-over-global resource precedence, a mobile v1 implementation specification, stable-only default macOS downloads, and a separate stable native release workflow that fails when signing/notarization credentials are absent.
- Automated verification on this date: daemon `make test` passed; macOS `make test-compatibility` passed (including 16 UI tests and the core suites); Worker `make test` passed 177 tests; Worker `make build` passed; macOS workflow syntax passed `make workflow-check`.
- A local unsigned arm64 app passed `make app-check`; Rosetta was unavailable, so this provides no Intel runtime evidence. The new source-built `tsq` client successfully listed the authenticated account’s projects and agents. Demo’s current Claude/Codex agent IDs are not present in this machine’s config, so no duplicate agents or tasks were created and no other daemon was disturbed.
- Not qualified by this checkpoint: production Demo Claude/Codex matrix, installed Swift provider execution, live D1 catalog updates/ETags/provider discovery, Developer ID signing/notarization/stapling/Gatekeeper, clean-machine install and lifecycle testing, or App Store sandbox feasibility. The new workflow is prepared but no signed stable artifact was produced.

The source catalog is a proposed, reviewable local catalog only; production resources were not changed. Continue with compatibility and resource gates, then run the Demo matrix sequentially against Go and Swift before attempting a signed release candidate.

The first local installation is `~/Applications/TaskSquad Native.app`; it was launched with a fixture via `make smoke` and its process was observed running. Markdown, JSON, logs and terminal controls have now been inspected in the installed app; remaining checks are listed above. A Go app was already running and was left intact.

Continue with interactive provider setup, tmux/FIFO execution, provider hooks and WebSocket relay, then supervisor/dreamer/synchronization and the remaining CLI/UI. Do not report the app finished while the above gates are incomplete. The development preview name and current stdout-only engine are temporary during implementation, not a reduced final scope.

The test suite now includes native document, terminal, and UI model tests; the optional Keychain integration test remains separate. The Keychain test passed separately via `make test-keychain`. This is an implementation checkpoint, not the completion audit. Source and binaries must be revalidated after further edits.

Go implementation details take precedence over stale CLI documentation. For example, current `auth.Logout` deletes local credentials without a remote revoke call. Current task sessions use `tsq-<sessionID>`, while Portals use `tsq-portal-<first8CharsOfID>`.

Latest usability checkpoint: `make test-compatibility` completed 64 tests with zero failures and one optional Keychain test skipped. `make test-ui` completed five native UI/model tests and produced inspectable renders. Universal bundle, install, DMG packaging and fixture launch passed. Computer Use authorization subsequently became available and the installed-app checks below ran successfully. The goal remains open.


### Installed-app and production observation checkpoint

On 2026-09-21, Computer Use exercised the installed app with a disposable loopback/tmux fixture, then the user's production configuration:

- Native file picker opened Markdown and JSON. Markdown headings, inline code, task lists, quote, code panel and table were visually inspected. Source mode displayed the original file.
- JSON expanded an array, searched the exact integer `90071992547409931234`, preserved that integer in source mode, and refreshed a changed Unicode string while the preview stayed open.
- The synthetic full-screen TUI accepted arrow/Enter input and `UI check café 猫`; status, activity and filtered log output reflected it. Fit resized the pane. History indicated paused input. Leaving Sessions detached its viewer; reattaching preserved the session state.
- Close Session displayed a destructive confirmation naming the synthetic target. Confirming removed that session; the other session on the isolated server remained listed.
- The production configuration hot-reloaded 17 agents. All 17 displayed idle, matching a separate read of the Go daemon's loopback status endpoint. Production activity history and an existing cdx-ts run log opened correctly.
- The default tmux server had no sessions, and the production endpoint reported zero active session names. Real provider attachment, task execution, and production state transitions were therefore not verified.
- The disposable server, remaining synthetic tmux session and synthetic journal were cleaned up. The user's updated configuration was preserved. The original Go app stayed running; the native engine was not started.

Visual finding at this checkpoint: the short JSON tree was vertically centered with excessive space above it. Fixed and verified in the installed app on September 23, as recorded below. Light/dark component renders are separate evidence from installed-app appearance testing.


### Real Codex E2E checkpoint (2026-09-22)

Task: [Native macOS Codex E2E smoke test](https://tasksquad.ai/dashboard/tasks/01M32Z4HPQRFKZAHR7R0D1P6CJ), assigned to `cdx-ts`. Created through the authenticated TaskSquad API because the installed `tsq` CLI has no task-creation command. `tsq sessions` and `tsq pane` supplied independent terminal evidence.

**Result: partial pass; full E2E failed.** The test task remains failed as diagnostic evidence.

Verified:

- Production task delivery reached the configured Codex agent. The installed Go app failed to launch `codex` because its PATH omitted the installed CLI location; its logs also showed legacy global Codex notify configuration.
- A temporary build of the current Go source, started with explicit local/Homebrew tool paths, launched Codex 0.154.0 in tmux. No installed application files were replaced, and the Swift engine was not involved in executing the provider.
- The native agent view changed to running. Open Terminal attached to `tsq-01M32Z9H8K5RFTTV4JPN5QWJFW` and displayed the real Codex TUI. Codex ran `pwd` and replied with `TSQ_NATIVE_E2E_READY`, the correct working directory, and `café 猫`. That first reply reached the hosted task, whose state became waiting_input.
- Pasting a follow-up into the native terminal and pressing Enter produced `TSQ_NATIVE_E2E_INPUT_OK café 猫`. Computer Use reported a clipboard timeout even though the paste visibly succeeded; it was inspected before submission. Simulated `typeText` did not preserve all non-ASCII characters, so Unicode evidence here is for paste and rendering, not direct character typing/IME.
- Detach preserved the Codex session; `tsq sessions` confirmed it, and reattachment worked.
- Native Close Session named the correct target in its confirmation and removed the tmux session. The agent returned to idle and `tsq sessions` reported none.

Failures requiring implementation work:

1. **Terminal input bypasses daemon turn bookkeeping.** The second Codex completion hook arrived with a distinct turn ID, but `Agent.StopAndPause` ignored it with `mode=waiting_input`. The second reply was visible in the TUI but absent from hosted task messages. Direct terminal input must participate in the managed task lifecycle without weakening duplicate/stale-hook guards.
2. **Deliberate close is reported as a crash.** Killing the managed tmux session through the native Close Session action caused `internalComplete(status="crashed")` and a failed task. Managed sessions need a daemon-aware cancel/close operation; raw tmux termination alone does not provide that contract.
3. **Native activity misses paused Codex replies.** The first reply appeared in the hosted task, but the local journal contained task_start/user-message records without that response. The native activity feed currently reads that journal, so it cannot present the complete conversation for this flow.
4. **Installed Go launch environment/release drift.** The installed app needs working Codex/tmux PATH discovery and the current invocation-scoped Codex integration. Testing with a temporary current-source process does not verify the installed Go release or native Swift provider execution.

Cleanup: the test tmux session is gone; the temporary Go process was stopped; the original installed Go app was relaunched with the tool PATH available for this launch. Application files, agent configuration and login registration were preserved. The obsolete global notify line generated by the old daemon specifically for this test was removed. The failed cloud task and its logs remain for diagnosis. Finder/login PATH behavior and a permanent Go app update remain unresolved.


### Managed Codex regression fixes and passing rerun (2026-09-22)

The synchronization, journal and deliberate-close failures from the preceding checkpoint are fixed in the current source. Passing rerun: [Native managed-terminal regression](https://tasksquad.ai/dashboard/tasks/01M34JF2C146V2MXJFR6YRJVPQ).

- Added loopback managed-terminal input/close endpoints to Go. Actions require the exact agent, task and tmux session; input also validates pane ownership. Browser-origin requests are rejected. Native Return submissions transition waiting_input to running before completion hooks can observe the state. Ordinary pasted newlines do not themselves count as a Return submission.
- Native managed controls use these endpoints and fail closed on older daemon versions or stale ownership. Screen rendering still uses an independent tmux control client. Custom sockets and ordinary unmanaged tmux sessions retain direct control.
- Close Session now explicitly marks a managed task complete through Go's completion path before killing its processes. Its confirmation explains that meaning. This uses the existing closed/done contract, not cancellation.
- Normal paused replies now append agent_turn events to the local journal. Delayed notify responses cannot pause or auto-close a replacement session after a concurrent close/reset.
- Fixed a terminal-client deinitialization crash exposed by rapid switching: cleanup no longer synchronously dispatches to a queue already executing that cleanup.

Installed-app evidence: Codex returned `TSQ_MANAGED_READY café 猫`; a follow-up pasted and submitted through the native terminal returned `TSQ_MANAGED_INPUT_OK café 猫`. The app showed running after submission, then waiting_input after the response. Both replies appeared in the hosted task and native Activity feed. Managed Close Session removed the tmux pane, returned the agent to idle, recorded task_end status closed locally, and left the hosted task in done. No project edits or tools were requested from Codex.

Validation: the Go suite passed, including a real isolated tmux/HTTP test for two turns, duplicate callback rejection, journal entries, stale-task and cross-session rejection, scoped close, unrelated-session survival, and delayed-response/replacement-session protection. Swift compatibility tests passed 67 tests with one optional Keychain test skipped and zero failures, including rapid switching and managed request/error tests. The universal native app built, passed bundle checks, and was installed for the desktop rerun.

Runtime cleanup: temporary Go process stopped; original installed Go app restored with its tool PATH available for this launch; all 17 agents idle and no default-server test sessions remain. The test-generated capture file and an abandoned stress-test server were removed. The passing cloud task remains as evidence. The new native build is installed, but the Go app on disk is unchanged and must be updated to enable managed input/close outside the temporary test runtime. Full native Swift provider execution, all-provider compatibility and signed release validation remain unfinished.

### Installed Go app and preview polish checkpoint (2026-09-23)

Passing task: [Installed macOS app Codex E2E](https://tasksquad.ai/dashboard/tasks/01M35R25XTA4AA7A64XXG4Y6DP).

- Built and checked the universal Go app, passed `make test-native`, and installed version `0.3.6-native-dev` at `/Applications/TaskSquad.app`. The previous app is preserved at `~/.local/share/tasksquad/backups/TaskSquad-before-managed-terminal-20260923.app`. This is a local development build without Developer ID signing/notarization validation.
- Launched the installed Go app with `open /Applications/TaskSquad.app`, without an explicit tool PATH for that launch. It successfully found and ran the configured Codex CLI. This verifies Launch Services launch on this machine, not login-item or clean-machine behavior.
- Rebuilt and installed the native app. It now launches against persistent `~/.tasksquad/config.toml`, verified semantically identical to the user's updated production fixture before switching.
- Created a small no-tools task for `cdx-ts` through the authenticated TaskSquad API. `tsq sessions` independently confirmed the managed session. Computer Use attached the Codex TUI, used Fit, pasted a Unicode follow-up and submitted it. Both `TSQ_INSTALLED_READY café 猫` and `TSQ_INSTALLED_INPUT_OK café 猫` appeared in native Activity and hosted task messages. Live state changed from waiting input to running and back.
- Native Close Session named the correct session and explicitly described task completion. Confirming removed the pane; the hosted task became done, all 17 agents returned to idle, and `tsq sessions` reported none. The existing completion path also posted a terminal capture as a final agent message; cleaner final-message presentation remains a separate improvement.
- Short JSON trees now align to the top. Five native UI tests passed, and both an offscreen render and the installed JSON preview were visually inspected. The exact large integer and Unicode values remained readable.

The updated apps remain installed and running locally. The Swift engine was not started for this Codex test: provider execution still used Go. The final single-app Swift architecture and full Go compatibility remain the objective; this development arrangement is a testing bridge, not completion of that architecture.

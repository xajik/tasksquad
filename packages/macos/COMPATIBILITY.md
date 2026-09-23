# Compatibility completion ledger

Objective: one native Swift macOS app, with the full observable behavior of the existing Go daemon, the same storage/configuration, the complete native local control panel, release pipelines, local installation, and end-to-end verification. Go remains for Linux. No embedded Go engine, web control panel, separate helper daemon, or Swift Linux target.

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

## Required before completion

- [ ] Extend TOML conformance coverage beyond current fixtures; cover all accepted Go document forms and rejected conflicts.
- [ ] Verify existing real-account Keychain reuse, including the OS authorization of the new executable.
- [ ] Qualify automatic engine startup/quit and menu/window lifetime through native UI tests; currently engine startup is explicit.
- [ ] Broaden polling tests to cancellation/restart, forced-poll coalescing, retry failure, and real Worker behavior.
- [ ] Complete agent state machine, task/session identity, stale hooks, duplicate notifications, replies, cancellation, reset and failure recovery.
- [ ] Provider detection and exact command/argument/environment/config generation for Claude, Codex, Gemini, OpenCode, Pi, Claw and stdout.
- [ ] Native child-process orchestration; tmux sessions, FIFO lifecycle, output drain, Unicode/whitespace fidelity and crash behavior.
- [ ] Hook routes and full CLI surface (`init`, sessions, attach, logs, pane, screenshot, send, report, send-image, skill, memory, kb, tags).
- [ ] Terminal WebSocket output/input/resize, auth headers, input gating, reconnect behavior and slow-reader handling.
- [ ] Portals: spawn, relay, close, crash recovery, session naming and shutdown.
- [ ] Session notifications/completion, transcripts/fallbacks, inbound attachments, encrypted artifact upload and screenshots.
- [ ] Skills, agents and commands synchronization; memory/KB behavior, close-step learning, supervisor, dreamer, orphan cleanup and analytics.
- [ ] Native setup, Agents, Supervisor, Sessions, Tasks, Logs and Tools feature parity; no inert placeholder controls.
- [ ] Login item activation/migration, Finder PATH propagation to child processes, wake/sleep and graceful quit.
- [ ] Complete Go↔Swift configuration/history/credential switching after draining work; no duplicate task claims.
- [ ] Real-provider end-to-end runs for every supported provider and hosted portal interaction.
- [ ] Complete remaining native UI lifecycle and production-provider interaction tests; initial desktop interaction now works.
- [ ] Intel runtime tests (cross-compilation alone is insufficient) and minimum-supported-macOS tests.
- [ ] Actual Developer ID signing, notarization, installed Gatekeeper checks and signed clean-machine install.
- [ ] Run remote CI, validate the signed draft release, then promote stable release/cask/CLI activation after full parity.

## Evidence and next work

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

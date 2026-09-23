# TaskSquad native macOS app

An independent Swift implementation of the TaskSquad daemon, with its engine and native control panel in one macOS process. Go remains the Linux implementation and the compatibility reference. Requires macOS 13+, Xcode 16+ / Swift 6, and Go for reference tests. No third-party Swift packages or embedded browser runtime.

**Work in progress: this is not yet a fully compatible daemon.** The app reads agent/supervisor configuration, watches configuration changes, supports browser sign-in, edits TOML, and displays existing logs/task journals. Its embedded engine currently runs explicit `stdout` providers, including polling, native processes, session completion and encrypted log uploads. The session workspace can attach to existing tmux sessions (including Go-created sessions), accept input, resize, show history, detach, and close sessions. Interactive provider execution in the Swift engine and background integrations are still being implemented. Do not retire the Go daemon based on this build. See [COMPATIBILITY.md](COMPATIBILITY.md) for the completion gates.

## Build and test

Run from `packages/macos`:

```sh
make build                  # local debug executable
make test                   # isolated Swift tests
make test-compatibility     # Go reference + Swift tests, including cross-process locking/crypto
make test-keychain          # isolated temporary Keychain entries, native <-> Go read/write
make test-ui                # native view/input tests and rendered UI artifacts
make workflow-check         # lint both native GitHub workflows
make app-check              # universal arm64/x86_64 .app, ad-hoc signature, bundle checks
make install                # install ~/Applications/TaskSquad Native.app
make smoke                  # launch installed app using the checked-in fixture configuration
make package                # DMG and SHA-256 for the already-built app
```

The standalone binary accepts `--version`, `--check-config [path]`, `login`, and `logout`. `--config <path>` selects the configuration used by the window. The complete Go CLI remains a required deliverable.

The development app uses bundle identifier `ai.tasksquad.native` and installs as `TaskSquad Native.app`. It does not replace the installed Go app, CLI, or login registration. Start Engine currently requires all agents to explicitly select `provider = 'stdout'` and acquires the shared daemon lock before any polling. Closing the window keeps the engine running; quitting drains the engine. Automatic activation and login-item migration remain pending full parity.

## Existing storage

- Configuration: `~/.tasksquad/config.toml`, including all current fields and defaults.
- Device identity: `~/.tasksquad/device-id` (preserved).
- Lock: `~/.tasksquad/daemon.lock` using the same BSD `flock` protocol; never unlink it.
- Daemon/task output: `~/.tasksquad/logs/`; lifecycle journals: `~/.tasksquad/tasks/`.
- Credentials: the login Keychain's `tasksquad-daemon` service and the six existing account names. Swift decodes historical hex and current base64 representations and writes Go-readable values. Existing Keychain entries may require macOS to authorize the new executable. Native creation retains access for Apple's `security` tool, which Go's keyring library uses.

Changes saved in the configuration editor are changes to the same file that Go uses. Unknown fields and comments are preserved because the original text is edited and validated rather than regenerated.

## Source layout

- `TaskSquad`: SwiftUI window, menu bar, app lifecycle, command dispatch.
- `TaskSquadCore`: actor-isolated engine/state/polling; POSIX subprocesses with exact Unicode argv and cancellation; Foundation configuration/filesystem support; Security credentials; CryptoKit encryption; URLSession transport/authentication/uploads; Network.framework loopback HTTP/login callback server.
- `Tests/GoReference`: test-only oracle linked to the real `packages/daemon` configuration and crypto packages. No Go executable is bundled in the application.

## Release tooling

`make app-signed` builds, validates, signs with Developer ID, submits to Apple's notarization service, verifies acceptance, and staples the ticket. Set `SIGNING_IDENTITY` and `NOTARY_PROFILE`; optionally set `NOTARY_KEYCHAIN` for a CI keychain. Then run `make package`. These commands need real signing credentials; passing ad-hoc checks is not proof of notarization.

`.github/workflows/macos-native.yml` runs reference tests, builds both architectures, checks installation, and uploads development DMGs. `.github/workflows/macos-native-preview.yml` is explicitly dispatched with a preview version and uses the existing Apple signing secret names to create a signed **draft prerelease**. It does not touch Go releases or the current Homebrew cask. Stable native release promotion is pending full compatibility validation.

Local tests use temporary configuration, synthetic credentials and loopback requests. They do not sign into a real account, claim production tasks, or replace the running Go process. The optional Keychain test creates and removes a unique test service in the login Keychain; it does not access the real TaskSquad service.

## Native workspace

Agents uses a live sidebar and activity feed, with Logs and Details tabs. While the Swift engine runs, its state drives the UI; when it is stopped, the app can observe a running Go daemon through its loopback status endpoint. Unavailable observations are cleared rather than displayed as current. Start/stop controls apply to the native engine. Stop Task cancels a native stdout run and closes its remote session.

Sessions discovers every pane on the selected tmux server. Select a pane to attach, type directly, use arrow/control keys, paste, and interact with mouse-enabled TUIs. Detach leaves the session running. For a managed task on the default tmux server, keyboard input and Close Session go through the Go daemon: submitting a reply updates task state, and closing marks the task complete before ending its processes. Other sessions use direct tmux control after an in-app confirmation. History shows up to 2,000 lines. Fit lets this client participate in tmux window sizing; the existing tmux window-size setting remains authoritative. The socket button selects a non-default server. The renderer uses tmux's screen and SGR attributes through a separate control client; it never replaces pipe-pane, embeds a browser, or changes tmux global options. Requires tmux with control-client flags (validated locally with 3.6a). Managed controls require a Go daemon containing the new `/hooks/terminal/input` and `/hooks/terminal/close` endpoints; older daemons can still be observed, but input/close fails with an update message instead of bypassing task bookkeeping. Custom sockets are treated as independent tmux servers.

Files opens Markdown/JSON/JSONL/log files via Command-O. Markdown includes headings, inline formatting, fenced code, quotes, lists, task lists and tables. JSON uses a searchable, collapsible tree with exact number lexemes and a source toggle. Logs support search, severity colors, selection/copy, and automatic refresh. Previews read at most 2 MiB and show a truncation notice; log/journal tails begin on a record boundary. File previews poll modification time once a second; sessions capture the visible screen about 16 times a second while open.

`make test-ui` writes offscreen AppKit/SwiftUI renders to `.build/ui-artifacts/`. These are component render checks, not proof of installed-app end-to-end usability. Computer Use has now exercised the installed file picker, previews, live refresh and terminal controls. Production configuration/status, existing logs and a two-turn Codex task were checked. On September 23, the updated Go app was installed locally with a backup and launched through Launch Services. A fresh Codex task verified native terminal submission, both replies in the hosted task and native journal, and Close Session finishing the task as done. The native app now uses the persistent `~/.tasksquad/config.toml`. These are local development builds; Swift provider execution and signed release validation remain incomplete. See the dated checkpoint in COMPATIBILITY.md for the exact scope and remaining issues.

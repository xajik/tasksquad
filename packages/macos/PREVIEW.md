Native Swift macOS development preview. Requires macOS 13 or later; includes Apple Silicon and Intel binaries.

**What's new in this preview**

- **Web-matched interface.** One project sidebar with the web app's sections, Lucide icons, and the TaskSquad logo, plus a separate **This Mac** window (⇧⌘M) for local agents, tmux sessions, task journals, logs, and configuration. Light, Dark, or System appearance (⌘,), with WCAG AA text contrast in both themes.
- **Interactive providers.** Claude Code, Codex, Gemini, OpenCode, and Claw run in managed tmux sessions with pause, reply, and post-task close steps. Pi and `stdout` run as pipe providers.
- **Portals.** The engine hosts browser Portals: a live tmux terminal streamed to the web app, with keyboard input and resize.
- **Skills, sub-agents, and commands sync.** Server default and auto-install resources are installed into each agent's work directory for every harness (hourly and on start), sharing lock files with the Go daemon. Running sessions can push learned skills through `/hooks/skill`.
- **Unattended start.** `--start-engine` starts the local daemon once configuration loads.

**Verified live against production** (native engine, TaskSquad project): Claude Code and Codex — two-round conversation, pause/reply, skill sync, and post-task `/tsq-end-session-learning` + `/tsq-end-session-memory`; Portals — open, live terminal, UTF-8 input, close; Pi — failures are reported with the provider's error output. Gemini, OpenCode, and Claw pass unit/integration tests but were not run live for this preview.

**Known issues**

- The server's default close steps include `/tsq-cleanup`, a skill that doesn't exist yet. Agents answer "Unknown command" and, with no per-step timeout, the session can stay in *wrapping up*. Tasks with explicit close steps are unaffected.
- The workspace sign-in must be repeated after installing a new build.

Install as **TaskSquad Native.app**. Go remains the Linux implementation and the reference for compatibility. Existing configuration changes affect both implementations.

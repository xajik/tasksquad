# Overview: Bun Daemon → Go Daemon Migration

## Current Bun Daemon Features

| File | Functionality |
|------|----------------|
| `config.ts` | JSON config loader, env var fallback, ~ expansion |
| `api.ts` | HTTP client with token auth |
| `logger.ts` | Structured logging to stdout |
| `hooks.ts` | HTTP server on port 7374 for Claude Code hooks |
| `agent.ts` | Agent state machine, Bun.spawn process, output streaming |
| `index.ts` | Main entry, tick loop |

## Key Differences to Implement in Go

1. **Process Management**: Bun.spawn → tmux sessions (persistent)
2. **Output Streaming**: stdout pipe → pipe-pane + capture-pane polling
3. **Log Storage**: in-memory array → log files in $TMPDIR
4. **Stuck Detection**: none → SHA-256 hash comparison per tick
5. **Config Format**: JSON → TOML with hot-reload via fsnotify
6. **UI**: none → systray menubar icon

## Implementation Priority

### Phase 1: Foundation
- [ ] TASK 1 — go.mod + dependencies
- [ ] TASK 2 — config/config.go (TOML + hot-reload)
- [ ] TASK 3 — api/api.go
- [ ] TASK 4 — logger/logger.go

### Phase 2: Core Agent
- [ ] TASK 5 — tmux/tmux.go (shell wrappers)
- [ ] TASK 6 — agent/agent.go (state machine, mode switching)
- [ ] TASK 7 — stream/stream.go (live output polling)

### Phase 3: Integration
- [ ] TASK 8 — hooks/server.go (Claude Code hooks)
- [ ] TASK 9 — upload/upload.go (R2 log upload)

### Phase 4: UI & Distribution
- [ ] TASK 10 — ui/systray.go (menubar icon)
- [ ] TASK 11 — main.go (entry point)
- [ ] TASK 12 — Distribution (Makefile, CI, install.sh)

### Phase 5: Testing
- [ ] TASK 13 — Unit & integration tests

## Migration Mapping

| Bun Daemon | Go Daemon (SPEC) |
|------------|------------------|
| `loadConfig()` | TASK 2.6: `config.Load()` |
| `apiPost()` | TASK 3.1: `api.Post()` |
| `log.info/debug/error` | TASK 4: `logger.Info/Debug/Error()` |
| `Bun.spawn` | TASK 5: `tmux.SendKeys()` |
| `streamOutput()` pipe reader | TASK 7: `stream.Run()` polling `capture-pane` |
| `writeHooks()` | TASK 8.4: `hooks.WriteHooks()` |
| hook endpoints | TASK 8.2-8.3: `/hooks/stop`, `/hooks/notification` |
| `agent.complete()` | TASK 6.8: `agent.Complete()` |
| `agent.setWaitingInput()` | TASK 6.9: `agent.SetWaitingInput()` |
| (none) | TASK 6.10-6.11: stuck detection |
| (none) | TASK 6.12-6.14: mode sync (live/accumulating) |
| (none) | TASK 10: systray UI |

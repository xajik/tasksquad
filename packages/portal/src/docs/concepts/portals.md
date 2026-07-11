---
title: Portals
description: Open a live, interactive terminal to an agent's machine directly from the browser.
tags: [portals, terminal, websocket, real-time, pro]
order: 7
---

# Portals

A Portal is a live, interactive terminal session — a real tmux pane on the agent's machine,
streamed byte-for-byte to the browser and rendered with [`xterm.js`](https://xtermjs.org/). It's
not a log tail: you can type into it, run a REPL, answer an interactive prompt, or just watch an
agent work, exactly as if you'd SSH'd into the machine yourself.

Portals are separate from [Tasks](../intro#tasks) — a Portal has no subject, no prompt, and no
message thread. It just opens the configured agent command interactively and connects you to it.

## Availability

- **Pro plan only.** Free-plan teams see an upgrade prompt instead of the portal list.
- **3 concurrent portals per team.** Creating a 4th while 3 are `pending`/`running` returns
  `portal_limit_reached`; close one first.

## Opening and closing a portal

1. From the portal's **Portals** tab, click **New portal** and pick a harness (agent).
2. The portal is created in `pending` status. The daemon picks it up on its next heartbeat poll —
   there's no push notification, so this can take up to `poll_interval` seconds (60s by default).
3. Once the daemon opens the tmux session, status moves to `running` and the live terminal
   appears.
4. Click **Close session** (visible on the portal's detail page while it's `pending`/`running`)
   to end it — this signals the daemon on its next heartbeat to kill the tmux session. The portal
   is also closed automatically if the underlying tmux session ends on its own.

## How it works

```
Browser                    Worker                      Daemon
   │                          │                            │
   │  POST /portals           │                            │
   │─────────────────────────▶│  insert row (status=pending)
   │                          │                            │
   │                          │◀── heartbeat poll ─────────│
   │                          │──── pending portal ────────▶│
   │                          │                            │  tmux new-session
   │                          │                            │  pipe-pane → FIFO
   │                          │◀─── POST daemon/portal/open│
   │                          │  status=running, session_id│
   │                          │                            │
   │                          │◀════ WebSocket (daemon) ═══│  raw PTY bytes
   │  POST /terminal/ticket   │                            │
   │─────────────────────────▶│  one-time ticket (60s TTL) │
   │  WS /terminal/:id?ticket │                            │
   │═════════════════════════▶│  fans out via              │
   │◀════ raw PTY bytes ══════│  TerminalRelay Durable      │
   │  (rendered by xterm.js)  │  Object                     │
```

Both the daemon and the browser connect to the same `TerminalRelay` Durable Object (one instance
per session, keyed by session ID). The daemon is the only writer; every connected browser is a
read/write viewer — keystrokes and resize events typed in the browser are forwarded back to the
daemon and injected into the tmux pane via `tmux send-keys`.

This is the same relay mechanism used for regular task sessions' live output — Portals just skip
the task/prompt/message-thread machinery and connect a bare interactive shell.

## Security

- The daemon's connection to the relay uses the same `Authorization: Bearer` + `X-TSQ-Agent`
  headers as every other daemon→worker request — no separate credential.
- The browser never receives a long-lived token for the WebSocket. It exchanges its normal
  session for a random, single-use **ticket** (`POST /terminal/ticket`, 60-second TTL, deleted on
  first use) and passes that in the WebSocket URL instead — keeping the Firebase JWT out of
  server access logs.
- A ticket only unlocks the specific session ID it was minted for, and only if the requesting
  user is a member of the team that owns the portal.

## Limits and behavior to know

- Portal tmux sessions are named `tsq-portal-<first 8 chars of the portal ID>`.
- The terminal is a genuine interactive session with no timeout of its own — it stays open until
  you close it, the daemon restarts and cleans it up, or the underlying process exits.
- Reconnecting after a dropped WebSocket is automatic in the browser client (exponential backoff,
  up to ~63 seconds of retries) — you don't need to refresh the page for a transient network blip.

## References

- [System Architecture](./architecture) — Where the `TerminalRelay` Durable Object fits in.
- [Security & Encryption](./security) — More on the one-time ticket flow.
- [Daemon CLI Reference](../api/daemon-cli) — `tsq sessions` / `tsq attach` also work against a portal's tmux session by name.

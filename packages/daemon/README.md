# TaskSquad Daemon

Polls the TaskSquad API for tasks and executes them using Claude Code.

## Prerequisites

- [Bun](https://bun.sh) installed
- `claude` CLI installed and authenticated (`claude --version`)
- `tmux` installed (optional — used only if you switch to tmux mode)

## Setup

### 1. Create config

```bash
mkdir -p ~/.tasksquad
cat > ~/.tasksquad/config.json << 'EOF'
{
  "apiUrl": "https://tasksquad-api.xajik0.workers.dev",
  "token": "tsq_YOUR_TOKEN_HERE",
  "teamId": "YOUR_TEAM_ID",
  "pollInterval": 10,
  "hooksPort": 7374,
  "agents": [
    {
      "id": "YOUR_AGENT_ID",
      "name": "local-dev",
      "command": "claude --dangerously-skip-permissions",
      "workDir": "/path/to/your/project"
    }
  ]
}
EOF
```

Get your token + agent ID from the web portal → Agents tab → Gen token.

### 2. Run

```bash
cd packages/daemon
bun run start
```

Or with env vars (single agent, no config file):

```bash
TSQ_TOKEN=tsq_... \
TSQ_TEAM_ID=01H... \
TSQ_AGENT_ID=01H... \
TSQ_AGENT_WORK_DIR=/path/to/project \
bun run src/index.ts
```

## How it works

1. Every `pollInterval` seconds, calls `POST /daemon/heartbeat` for each agent
2. If a pending task is returned, spawns `claude -p "<task>" --dangerously-skip-permissions` in the agent's `workDir`
3. Streams stdout line-by-line to the server (`POST /daemon/push/:agentId`) — visible in the portal's "Session log"
4. Writes `.claude/settings.json` hooks in the project directory pointing to the local hook server (port 7374)
5. When Claude finishes (`Stop` hook fires or process exits), calls `POST /daemon/session/close` with the final output
6. When Claude is waiting for input (`Notification` hook), moves task to `waiting_input` — user replies in the portal, daemon picks up next heartbeat

## Claude Code hooks

The daemon auto-writes `.claude/settings.json` in your project's directory with:

```json
{
  "hooks": {
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "curl ... http://localhost:7374/hooks/stop ..." }] }],
    "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "curl ... http://localhost:7374/hooks/notification ..." }] }]
  }
}
```

These fire the local hook server when Claude finishes or needs input.

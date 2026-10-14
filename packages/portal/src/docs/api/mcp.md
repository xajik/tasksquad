---
title: MCP Server
description: Connect Claude Code, Codex, Cursor and other MCP clients to TaskSquad so AI agents can work with your projects, tasks, notes and agents.
tags: [mcp, api, agents, oauth, integrations]
order: 6
---

# MCP Server

TaskSquad runs a remote [Model Context Protocol](https://modelcontextprotocol.io) server. Any MCP
client — Claude Code, Codex, Cursor, Claude Desktop, the MCP Inspector — can connect to it and
work with TaskSquad the way you do in the portal: read the inbox, send and reply to tasks, manage
notes, conveyors and planners, look up memory and stats, and watch a live terminal.

The agent acts **as you**. It sees the projects you belong to and can do what your role allows,
except for a short list of actions that stay [manual](#actions-that-stay-manual).

```screenshot
src: /docs/screenshots/mcp.webp
alt: MCP Inspector connected to TaskSquad, listing its tools
width: 1440
height: 892
```

## Connect

The server URL is:

```
https://tasksquad.ai/mcp
```

**Claude Code**

```bash
claude mcp add --transport http tasksquad https://tasksquad.ai/mcp
```

Then run `/mcp` inside Claude Code and choose **tasksquad → Authenticate**.

**Codex**

```bash
codex mcp add tasksquad --url https://tasksquad.ai/mcp
codex mcp login tasksquad
```

**ChatGPT** — open the [TaskSquad plugin](https://chatgpt.com/plugins/plugin_asdk_app_6acef16012c4819196f4de152ef2ea03),
install it and sign in. Then switch to **Work**, start a chat and type `@TaskSquad`. To add it by
hand instead: ChatGPT → Plugins → **+** → *Add custom MCP server*, URL `https://tasksquad.ai/mcp`,
authentication **OAuth**, client registration **CIMD** (or DCR).

**Other clients** — add a remote (Streamable HTTP) server with the URL above. The client
discovers the OAuth endpoints on its own; there is no API key to paste.

## Signing in

The first time a client connects it opens your browser:

1. **Consent.** TaskSquad shows which app is asking for access. Approve only apps you started
   yourself.
2. **Sign in** with Google or GitHub — the same account you use on tasksquad.ai. If you are
   already signed in, this step finishes on its own.
3. The browser returns to the client and the tools appear.

Access lasts **30 days**. After that, or if you revoke it, tools answer *"TaskSquad session
expired — reconnect the MCP server"* and the client asks you to sign in again.

## What agents can do

| Area | Tools |
|---|---|
| Account & projects | `whoami`, `list_projects`, `create_project`, `update_project_settings`, `list_project_members`, `get_project_stats` |
| Agents | `list_agents`, `create_agent`, `update_agent_role`, `pause_agent`, `reset_agent` |
| Tasks | `list_tasks`, `get_task`, `create_task`, `reply_to_task`, `edit_scheduled_message`, `delete_scheduled_message`, `close_task`, `forward_task`, `grade_task`, `grade_message`, `update_task_settings`, `get_message_transcript`, `get_message_attachment` |
| Conveyor | `list_conveyors`, `create_conveyor`, `update_conveyor`, `pause_conveyor`, `list_conveyor_tasks` |
| Notes | `list_notes`, `get_note`, `create_note`, `update_note`, `archive_note`, `add_note_comment`, `convert_note_to_task`, `critique_note` |
| Skills, sub-agents, commands | `list_library`, `get_library_item`, `create_library_item`, `update_library_item` |
| Memory | `list_memory`, `get_memory`, `list_memory_rollups`, `list_tags` |
| Planner | `list_planners`, `get_planner`, `create_planner`, `update_planner` |
| Monitor | `open_monitor` — in ChatGPT and other MCP Apps hosts, shows a live view of agents and of tasks that need input, are running, queued or recently finished |
| Portals & terminal | `list_portals`, `get_portal`, `open_portal`, `close_portal`, `read_live_terminal`, `send_terminal_input` |

```screenshot
src: /docs/screenshots/mcp-call.webp
alt: list_agents result for a project in MCP Inspector
width: 1440
height: 892
```

A few details worth knowing:

- **IDs come from list tools.** Start with `list_projects`, then `list_agents` / `list_tasks` for
  that project.
- **Times are ISO-8601**, e.g. `2026-10-12T09:00:00Z` for `create_task`'s `scheduled_at`.
- **Grades** are `1` (👍), `0` (👎) or `null` to clear. A grade on the last message is what the
  [Planner](/docs/concepts/planner) reads as pass/fail.
- **Images** can be attached to `create_task` and `reply_to_task` as base64.
- **`read_live_terminal`** returns the recent output of a running task or [Portal](/docs/concepts/portals)
  as plain text. **`send_terminal_input`** types into it — this runs input on the agent's machine,
  exactly like typing in the portal's terminal, so clients mark it as destructive.

## Actions that stay manual

Some actions are deliberately not available to agents. The tools exist so the agent knows about
them, but they always answer: *"The user needs to take this action manually…"* with a link to the
right place in the portal.

| Tool | Do it in the portal |
|---|---|
| `delete_project` | Project → Settings |
| `add_project_member`, `remove_project_member` | Project → Members |
| `delete_agent`, `create_agent_token` | Project → Agents |
| `delete_task` | Inbox |
| `delete_conveyor` | Conveyor |
| `delete_note`, `delete_note_comment` | Notes |
| `delete_library_item` | Skills |
| `delete_planner` | Planner |

## How it works

```
MCP client ──OAuth 2.1 (PKCE + dynamic registration)──▶ tasksquad.ai/oauth/*
   consent page ──▶ tasksquad.ai sign-in ──▶ one-time code ──▶ TaskSquad API token (30 days)
MCP client ──Bearer token──▶ tasksquad.ai/mcp ──▶ api.tasksquad.ai (as you)
```

- The server is stateless: every request is checked and forwarded to the same API the portal
  uses, so permissions and plan limits are identical.
- Your TaskSquad token never reaches the MCP client. The client only holds its own OAuth token,
  and the API token is stored encrypted on the server side.

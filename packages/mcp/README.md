# TaskSquad MCP server

Remote [MCP](https://modelcontextprotocol.io) server that lets AI agents work in TaskSquad the way people do in the web portal: read the inbox, create and reply to tasks, and manage notes, conveyors, planners, the skill library and portals (including the live terminal).

It's a Cloudflare Worker (`tasksquad-mcp`). It acts as an OAuth 2.1 authorization server ([`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)) and forwards every tool call to the TaskSquad API (`packages/worker`) as the signed-in user.

## Connect

```bash
claude mcp add --transport http tasksquad https://tasksquad.ai/mcp
# or directly: https://tasksquad-mcp.xajik0.workers.dev/mcp
```

Any MCP client that supports Streamable HTTP and OAuth (dynamic client registration and PKCE) can connect. On first use the client opens a browser:

1. A consent page names the client that wants access.
2. TaskSquad sign-in (Google or GitHub), using the same page the iOS app uses.
3. The browser returns to the client.

## How sign-in works

```
client ── /oauth/authorize ──▶ consent page (per-client, browser-bound)
        ── approve ──▶ tasksquad.ai/mobile/authorize?redirect_uri=<origin>/oauth/callback&code_challenge&state
portal  ── Firebase sign-in → POST api /mobile/authorization/codes → <origin>/oauth/callback?code&state
/oauth/callback ── POST api /mobile/authorization/exchange {code, code_verifier, client:"mcp"} → tsq_cli_* token (30 days, label "MCP")
          ── completeAuthorization(props = { apiToken, userId, email })  → client gets its OAuth code → /oauth/token
/mcp     ── Bearer <OAuth access token> → ctx.props.apiToken → TaskSquad API
```

- The `tsq_cli_*` token is kept only inside the encrypted grant props.
- The grant's refresh token lasts 30 days, the same as the API token. After that the client signs in again.
- If the API token is revoked earlier, tools return "reconnect the TaskSquad MCP server".

`/mcp` is stateless Streamable HTTP. Each request builds a fresh `McpServer` for the caller, so there is no Durable Object.

## Tools

| Area | Tools |
| --- | --- |
| Account / projects | `whoami`, `list_projects`, `create_project`, `update_project_settings`, `list_project_members`, `get_project_stats` |
| Agents | `list_agents`, `create_agent`, `update_agent_role`, `pause_agent`, `reset_agent` |
| Tasks (inbox) | `list_tasks`, `get_task`, `create_task`, `reply_to_task`, `edit_scheduled_message`, `delete_scheduled_message`, `close_task`, `forward_task`, `grade_task`, `grade_message`, `update_task_settings`, `get_message_transcript`, `get_message_attachment` |
| Conveyors | `list_conveyors`, `create_conveyor`, `update_conveyor`, `pause_conveyor`, `list_conveyor_tasks` |
| Notes | `list_notes`, `get_note`, `create_note`, `update_note`, `archive_note`, `add_note_comment`, `convert_note_to_task`, `critique_note` |
| Library | `list_library`, `get_library_item`, `create_library_item`, `update_library_item` (`kind`: skills / sub-agents / commands) |
| Memory | `list_memory`, `get_memory`, `list_memory_rollups`, `list_tags` |
| Planners | `list_planners`, `get_planner`, `create_planner`, `update_planner` |
| Portals / terminal | `list_portals`, `get_portal`, `open_portal`, `close_portal`, `read_live_terminal`, `send_terminal_input` |

**Manual-only actions.** The following tools are listed but always return an error telling the agent that *the user needs to take this action manually* in the portal:
`delete_project`, `add_project_member`, `remove_project_member`, `delete_agent`, `create_agent_token`, `delete_task`, `delete_conveyor`, `delete_note`, `delete_note_comment`, `delete_library_item`, `delete_planner`.
They are defined in `src/tools/blocked.ts`.

Endpoint paths and bodies mirror `packages/portal/src/lib/api.ts`. When the portal API changes, update `src/api.ts` too.

## One-time setup

```bash
bunx wrangler kv namespace create OAUTH_KV   # paste the id into wrangler.toml
```

- `PUBLIC_URL` (in `wrangler.toml`) must be this worker's origin.
- `<origin>/oauth/callback` must be listed in:
  - the worker's `MCP_REDIRECT_URIS` var (`packages/worker/wrangler.toml`)
  - the portal's MCP allowlist (`packages/portal/src/pages/MobileAuth.tsx`, which can be overridden with `VITE_MCP_REDIRECT_URIS`)
- Deploy the worker and the portal before the MCP server.

## Develop

```bash
cp .dev.vars.example .dev.vars   # local worker :8787, portal :5173, this server :8788
make install
make dev                          # wrangler dev --port 8788
make test                         # vitest (plain Node; cloudflare:workers is stubbed)
make build                        # tsc + wrangler deploy --dry-run
npx @modelcontextprotocol/inspector   # connect to http://localhost:8788/mcp
```

Deploys run from `.github/workflows/deploy-mcp.yml` on pushes to `main` that touch `packages/mcp/**`.

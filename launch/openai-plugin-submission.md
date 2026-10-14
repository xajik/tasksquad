# TaskSquad plugin for ChatGPT / Codex: submission kit

The package lives in `launch/openai-plugin/`; this file stays out of the ZIP.
Sources: https://developers.openai.com/plugins/quickstart, `/plugins/build/plugins`,
`/plugins/deploy/submission`, `/plugins/deploy/app-review`, `/plugins/plugin-guidelines`.

```
launch/openai-plugin/
├── plugin.json                 manifest + listing (extensions.com.openai.interface)
├── mcp.json                    https://tasksquad.ai/mcp, OAuth via DCR
├── skills/setup/SKILL.md       onboarding skill
├── skills/delegate-task/SKILL.md
└── assets/logo.png (512²), icon.png (192²)
```

Build the ZIP with the files at its root:

```bash
cd launch/openai-plugin && zip -r ../tasksquad-openai-plugin-1.0.0.zip . -x '.*'
```

## Already in place (verified 2026-10-14)

- `https://tasksquad.ai/mcp` is public HTTPS, Streamable HTTP, returns `401` with
  `WWW-Authenticate: Bearer resource_metadata=...` (correct behaviour for an OAuth-protected server).
- `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` resolve.
- Dynamic Client Registration works at `/oauth/register` with ChatGPT's redirect URI
  (`https://chatgpt.com/connector_platform_oauth_redirect`).
- Every tool has `readOnlyHint` / `destructiveHint` / `openWorldHint` annotations.
- Apps SDK auth: per-tool `securitySchemes: [{type:"oauth2"}]`, `mcp/www_authenticate` challenge
  when the stored TaskSquad token is rejected, `openai/profile` on `whoami`, CIMD enabled
  alongside DCR, `structuredContent` on object/array results.
- Destructive, membership and credential tools always return "do this in the portal".
- `/privacy` and `/terms` pages exist.

## Must do before submitting

1. **Organisation verification**: platform.openai.com → Settings → Organization → verify
   (individual or business). The listing shows that verified name. Use a project with global data residency (EU-residency projects can't submit MCP plugins).
2. **Reviewer account without MFA**: the portal only has Google and GitHub sign-in, and both
   can trigger device or email challenges. Reviewers can't complete those, and that's a common
   rejection reason. Options: enable Firebase email/password sign-in for a dedicated reviewer
   account, or a reviewer-only Google account with challenges switched off (fragile). The account
   needs a project, **one online agent** (use the free Pi agent on an always-on machine) and
   some tasks and notes as sample data.
3. **Support page**: `plugin.json` uses `https://tasksquad.ai/support`, which doesn't exist yet. Create it
   (contact email + link to /howto) or change the URL. All four URLs must be HTTPS and live.
4. **Privacy policy coverage**: list every category of personal data the tools return
   (account email and name from `whoami`, project member names and emails, task and message
   content, terminal output, agent machine hostnames, if any). Remove anything a tool returns that isn't listed.
5. **Domain verification**: the dashboard gives you a token. Serve it as plain text at
   `https://tasksquad.ai/.well-known/openai-apps-challenge` (currently 404). The simplest way is
   `packages/portal/public/.well-known/openai-apps-challenge` containing only the token, then
   deploy the portal.
6. **Annotations** (the scanner and reviewers check them against real behaviour):
   `send_terminal_input` and `reset_agent` are `DESTRUCTIVE`. Decide whether `create_task`,
   `reply_to_task` and `forward_task` should be too (they make an agent act on the user's
   machine), and prepare a justification. Justifications can't override annotations.
7. **Demo video**: a screen recording, accessible to reviewers, that runs the 5 positive test cases below.
8. **Test in ChatGPT first**: follow the steps under "Test before submitting" below.

## Test before submitting

1. ChatGPT → Plugins → **+** → *Add custom MCP server* → URL `https://tasksquad.ai/mcp`,
   auth **OAuth** → *Create as a plugin*. Sign in through the TaskSquad consent page.
2. Switch to **Work** mode, start a chat, type `@TaskSquad`, and run every test case below.
3. Optional: to test the full package (skills + MCP), copy the `plugin_asdk_app…` ID from the URL and
   run `@plugin-creator` (ChatGPT Work) or `$plugin-creator` (Codex) with that ID. Or
   test locally in Codex: copy the package to `~/.codex/plugins/tasksquad` and add it to
   `~/.agents/plugins/marketplace.json`.

## Submission flow

platform.openai.com → Plugins / Apps dashboard → New plugin → **With MCP** → upload ZIP →
fix validation findings → connect MCP (OAuth, DCR) → domain verification → review details
(test cases, demo URL, reviewer credentials, release notes, countries, `commerce: false`) →
**Submit for review** → once approved, **Publish plugin**.
After publishing, server-side tool changes go live automatically after the daily scan. You can't change the MCP
origin (`tasksquad.ai`) without creating a new plugin.

## Positive test cases (5 required)

| # | Prompt | Tools triggered | Expected behaviour |
|---|---|---|---|
| 1 | "Which of my TaskSquad agents are online?" | `list_projects`, `list_agents` | Lists the reviewer project's agents with online/offline status; the Pi demo agent shows as online. |
| 2 | "Ask the Pi agent in Demo project to write a haiku about TypeScript." | `list_projects`, `list_agents`, `create_task` | Creates a task addressed to the Pi agent and confirms the subject and that the agent picks it up within about a minute. |
| 3 | "What did the agent reply to my haiku task?" | `list_tasks`, `get_task` | Summarises the agent's latest message (the haiku) and the task status. |
| 4 | "Reply to that task: make it about Go instead, then close it once it answers." | `reply_to_task`, `get_task`, `close_task` | Sends the reply; after the agent answers, shows the new haiku and closes the task. |
| 5 | "Create a note in the Demo project titled 'Release checklist' with three items." | `list_projects`, `create_note` | Creates the note and returns its title and contents. |

## Negative test cases (3 required)

| # | Prompt | Why the plugin should not act | Expected fallback |
|---|---|---|---|
| 1 | "What's the weather in Paris?" | Unrelated to TaskSquad. | Answers without calling any TaskSquad tool. |
| 2 | "Delete the Demo project." | Destructive actions are portal-only by design. | Calls `delete_project` at most once, which returns the manual-action message, and tells the user to delete it in the portal. Nothing is deleted. |
| 3 | "Give my teammate bob@example.com access to the Demo project." | Membership changes are portal-only. | No membership change; tells the user to add the member in the TaskSquad portal. |

## Release notes (1.0.0)

First release: send tasks to your TaskSquad AI agents from ChatGPT and Codex, track their replies,
answer their questions, read live terminals, and manage notes, planners and conveyors.

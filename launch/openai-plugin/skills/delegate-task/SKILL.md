---
name: delegate-task
description: Send a piece of work to a TaskSquad AI agent and follow it to completion. Use when the user asks an agent to do something, or asks about the status of a task they sent.
---

1. Resolve the project and agent: `list_projects`, then `list_agents`. If more than one agent fits,
   ask the user which one. Prefer an online agent and say so if the chosen one is offline.
2. Write a self-contained task: a clear subject, the goal, relevant context the user gave, and what
   "done" looks like. Send it with `create_task`.
3. Tell the user the task was sent and that the agent picks up new work on its next poll
   (about a minute).
4. When the user asks for an update, call `get_task`. Summarise the agent's latest message rather
   than pasting the whole thread.
   - Status `waiting_input`: relay the agent's question and send the user's answer with `reply_to_task`.
   - Status `done`: summarise the result and offer to close it with `close_task`.
5. Use `read_live_terminal` only when the user wants to see what the agent is doing right now.
   Use `send_terminal_input` only with text the user explicitly asked to send.

Never delete anything, change members or create tokens: those tools always fail by design. Point the
user to the TaskSquad portal instead.

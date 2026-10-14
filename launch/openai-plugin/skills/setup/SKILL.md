---
name: setup
description: Onboard a new TaskSquad user in ChatGPT. Use when the user first installs TaskSquad, has no projects or agents yet, or asks how to get started.
---

Help the user get to their first completed task.

1. Call `whoami` to confirm the connection, then `list_projects`.
2. If there are no projects, offer to create one with `create_project`.
3. Call `list_agents` for the project. If there are no agents, offer `create_agent`, then explain that
   the user must create an agent token in the TaskSquad portal (https://tasksquad.ai) and run the
   `tsq` daemon on their machine. Agent tokens cannot be created from ChatGPT.
4. If an agent exists but is offline, tell the user to start the daemon on that machine (`tsq start`).
5. Once an agent is online, suggest a small first task and send it with `create_task`.

Keep it short. Do not explain features the user did not ask about.

---
title: Inbox & Tasks
description: Send tasks to AI agents like email, follow their work live, reply mid-task, and close sessions.
tags: [inbox, tasks, threads, agents]
order: 3
---

# Inbox & Tasks

The inbox is the shared surface where your team and your agents work. Every task is an email-style thread: you
write a subject and a description, pick an agent, and the agent replies in the same thread.

```screenshot
src: /docs/screenshots/inbox.webp
alt: The inbox, with tasks across four agents
width: 1309
height: 688
```

```screenshot
src: /docs/screenshots/thread.webp
alt: A task thread: prompt, tool calls and the agent reply
width: 1308
height: 600
```

## Sending a task

Click **New message**, choose an **Agent**, and write a **Subject** and **Description**. Optional settings:

- **Attach image**: screenshots or mockups are delivered to the agent with the task.
- **Auto-close after first response**: closes the session as soon as the agent replies. Good for one-shot questions.
- **Save tokens**: asks the agent to answer tersely.
- **Session close steps**: slash commands run before the session closes, such as `/tsq-end-session-learning`
  (see [Skills & Learning](./skills)).
- **Schedule**: send the task later instead of now.

## Task lifecycle

| Status | Meaning |
|---|---|
| `pending` | Waiting for the agent's daemon to pick it up on its next poll |
| `running` | The agent is working; its tool calls appear in the thread as they happen |
| `waiting_input` | The agent replied and is waiting for you |
| `done` / `failed` | The session was closed |

The daemon polls for work, so a new task starts within one poll interval: 60 seconds by default, 5 seconds on Pro.

## Working in a thread

- **Activity rows**: thinking, tool calls, and tool results appear as compact rows you can expand.
- **Reply**: steer the agent mid-task; your reply is typed into its live session.
- **Forward**: hand the thread to another agent with extra instructions.
- **CLI transcript**: the full, encrypted session transcript (see [Security](./security)).
- **👍 / 👎**: grade replies and tasks. Grades feed [Analytics](./analytics).
- **Close Session**: runs the close steps and marks the task done.

Stuck tasks are picked up automatically by the [Supervisor](./supervisor).

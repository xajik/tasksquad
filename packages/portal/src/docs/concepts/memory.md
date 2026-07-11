---
title: Memory
description: How TaskSquad agents build and share persistent project knowledge across sessions.
tags: [memory, knowledge, learning, automation, cli]
order: 8
---

# Memory

Memory is how agents retain *facts* about a project across sessions — decisions, conventions,
structure, and notable events — separate from [Skills](./skills), which capture reusable
*procedures*. Where a skill says "here's how to do X," a memory entry says "here's something
true about this project."

Every memory entry belongs to one of 5 categories and one of 2 scopes:

| Category | What it captures |
|---|---|
| `personal` | Facts about the people involved — who owns what area, who to ask about X |
| `preferences` | Team/user conventions — code style, tools, workflow choices |
| `structure` | Where things live — directory layout, file naming, module boundaries |
| `architecture` | Design decisions and why — why X over Y, how a subsystem works |
| `events` | Notable things that happened — a migration ran, a dependency was upgraded, an incident occurred |

## Scope: local vs. global

- **`global`** — project-wide facts a teammate or another agent (possibly on a different
  machine) would benefit from. Pushed to the team's shared memory in the Worker's D1 database,
  visible to every agent and portal user on the team.
- **`local`** — facts tied specifically to *this* machine or checkout: a local port conflict, an
  environment-specific workaround, a personal fork used for testing. Written as a markdown file
  under `<work_dir>/.tsq/memory/<category>/` and **never leaves the machine** — no daemon
  network call, no server-side record. `.tsq/` is gitignored, the same convention already used
  for locally-installed [skills](./skills) (`.tsq/skills/`), sub-agents, and commands.

Local scope exists because there's no daemon-to-daemon channel in TaskSquad — every agent talks
to the Worker, never directly to another agent's machine. Rather than trying to build one, local
memory sidesteps the problem entirely: any agent session running in the same working directory
already has filesystem access to `.tsq/memory/`, so knowledge shared there is automatically
visible to whichever agents happen to work in that checkout, with zero coordination required.
Genuinely cross-machine knowledge has nowhere to live except the Worker, so that's what `global`
is for.

**Local memory has no Portal presence.** It never reaches the server by design, so the Memory
page in the Portal only ever shows `global` entries.

## How entries get created

Memory extraction happens automatically at the end of a session, via the close-step skill
mechanism also used for [skill learning](./skills):

```
Task closes (status → wrapping_up)
        ↓
Daemon runs the task's close_steps in order, injected into the live session as slash commands:
  /tsq-end-session-learning   (existing — extracts reusable skills)
  /tsq-end-session-memory     (extracts memory facts)
  /tsq-cleanup
        ↓
The /tsq-end-session-memory skill reflects on the session against the 5 categories,
decides local vs. global per fact, and saves each one
```

The `/tsq-end-session-memory` step is included in a task's default `close_steps` only when the
team's **Memory** setting is enabled (see below) — it's skipped entirely otherwise, the same way
`/tsq-end-session-learning` is gated by the **Learning from session** setting.

The skill is deliberately conservative: most sessions produce zero or one memory-worthy fact, and
it's explicitly instructed *not* to attempt a "what happened today" summary — see Rollups below
for why that has to happen server-side instead.

## Rollups: short-term memory

Daily and weekly summaries ("what's happened on this project recently") are **not** produced by
the close-session skill — an in-session skill only ever sees its own session, never what other
agents on the team did that same day, so it structurally cannot produce an accurate team-wide
summary. Instead, an hourly Cron Trigger on the Worker checks each team and, once a day/week's
worth of `global` memory entries exist, compiles them into a `memory_rollup` row.

The daemon receives the team's latest daily rollup automatically in its heartbeat response
whenever a new task is dispatched, and it's prepended to the agent's initial prompt as a short
"Project memory (recent activity)" section — no action needed to see it, and no CLI command
required. This is the *only* memory content that's auto-injected; full long-term memory is
reachable on demand instead (see CLI below), so prompts don't balloon with historical context
the current task doesn't need.

## Settings

Team maintainers can toggle memory extraction independently of skill learning, in the team's
**Settings** view in the Portal (the same place as the **Learning from session** toggle). Turning
it off:

- Stops `/tsq-end-session-memory` from being appended to new tasks' `close_steps`.
- Stops the daemon from receiving rollup content in its heartbeat response.
- Does **not** delete existing memory entries — they remain visible, just no new ones are created
  and no rollup is injected while disabled.

## Viewing memory in the Portal

The **Memory** page (Portal sidebar) shows a card per `global` entry — title, category badge,
tags, and the agent that produced it — filterable by category. Selecting a card opens a detail
pane with the full content and a list of other entries sharing at least one tag, the same
card-grid-plus-detail-pane pattern used by [Skills](./skills).

## References

- [Skills & Learning](./skills) — The sibling mechanism for reusable procedures, and the
  close-step machinery memory extraction reuses.
- [System Architecture](./architecture) — Where the Worker's D1 store and the daemon's local
  `.tsq/` directory fit into the bigger picture.
- [Daemon CLI Reference](../api/daemon-cli) — `tsq memory` and `tsq tags` command reference.

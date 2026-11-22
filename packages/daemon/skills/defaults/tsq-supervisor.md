---
name: tsq-supervisor
description: Safe, evidence-based supervision of a TaskSquad agent team
---

# Supervise TaskSquad agents

Inspect the requested project, current task state, recent heartbeats, and relevant logs before suggesting a change. Separate observed facts from hypotheses and cite task IDs or timestamps where available.

Only act within the selected project's membership and the user's request. Do not interrupt active work, change schedules, mutate configuration, close tasks, or send messages without explicit authorization. Prefer the least disruptive supported recovery. Preserve evidence and unrelated sessions.

After a permitted action, verify the resulting task and agent state independently. Report what changed, what remains uncertain, and any follow-up needed. Do not expose credentials, private prompts, or unrelated project data.

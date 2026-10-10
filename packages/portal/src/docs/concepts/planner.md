---
title: Planner
description: Coordinate multi-phase work across agents, with an approval gate and optional Supervisor check per phase.
tags: [planner, phases, orchestration, sub-agents]
order: 6
---

# Planner

A Planner breaks a larger goal into ordered **phases** and runs them one after another. Each phase can be handled by
a different agent, so a spec can go to a research agent, the API to a backend agent, and the UI to another.

```screenshot
src: /docs/screenshots/planner.webp
alt: A planner in its third phase
width: 1309
height: 688
```

## Phases

Each phase has:

- **Harness**: the agent that runs the phase.
- **Sub-agent** (optional): a [sub-agent](./skills) definition that the harness uses for the phase, such as
  `api-designer` or `test-writer`.
- **Supervisor check** (optional): after the phase completes, a supervisor task verifies the result before the plan
  moves on.

Planner-level defaults set the harness, sub-agent, and **Max retries per phase**.

## Flow

1. The current phase's task is sent to its harness agent, and the phase shows **in progress**.
2. When the agent finishes, the phase is **completed** and its last response is shown on the planner.
3. Grade the phase's task in the inbox, or use **Proceed** / **Stop** on the planner. 👍 approves the phase and
   starts the next one. 👎 rejects it, and the phase is retried up to the retry limit.
4. **Pause** keeps the planner from starting the next phase after an approval until you resume it.

Every phase task is a normal inbox thread; use **Open linked task** to jump to it.

---
title: Analytics
description: Task outcomes, agent activity, tool and token usage, and feedback across your team's agents.
tags: [analytics, metrics, usage, agents]
order: 10
---

# Analytics

Analytics shows how your agents are doing across tasks. Filter by **24h**, **7 days**, **30 days**, or **90 days**,
and by a single agent or all agents.

```screenshot
src: /docs/screenshots/analytics.webp
alt: Analytics for a 30-day window
width: 1309
height: 688
```

## What's measured

- **Tasks created / done / failed**, **success rate** (done ÷ done + failed), **median time to done**, and tasks
  **in progress**.
- **Tool calls**, **tokens**, and **agent active time**. These come from session metrics that the daemon reports
  when a session closes, so they only include providers that report them.
- **Feedback**: 👍 / 👎 grades given in the inbox.
- **Completed tasks per day**, **most used tools**, **skills used**, and an **agent performance** table with
  per-agent success rate, median time, and token usage.

---
title: Conveyor (scheduled prompts)
description: Run prompts on a schedule so agents handle recurring work automatically.
tags: [conveyor, schedule, automation, recurring]
order: 6
---

# Conveyor

A Conveyor sends the same task to an agent on a schedule, for example a morning digest, a weekly dependency audit,
or nightly flaky-test triage. Each run creates a normal inbox task, so you can follow and reply to it like any other.

## Creating a Conveyor

Choose an agent, write the subject and prompt, then set:

- **Frequency**: hourly, daily, weekly (pick the day), or monthly (pick the day of the month), at a time in your
  timezone.
- **Max runs** (empty = unlimited) and an optional **End date**.
- **Auto-close**: closes each run's session after the agent's first reply.

## Managing Conveyors

Each Conveyor shows its schedule, its agent, the next run time, and how many times it has run. From the list you can
**Run now**, **View tasks** created by it, **Pause** or resume it, **Edit** it, or **Delete** it.

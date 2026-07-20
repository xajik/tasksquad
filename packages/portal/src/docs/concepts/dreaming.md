---
title: Dreaming
description: How agents turn daily Memory activity into a git-tracked knowledge base they can search instead of re-exploring the codebase.
tags: [dreaming, knowledge-base, memory, automation, cli]
order: 9
---

# Dreaming

Dreaming is a nightly background job that turns each day's [Memory](./memory) activity into a
small, git-tracked **knowledge base** (`tsq/kb/`) that mirrors the project's folder structure. It
builds directly on Memory but solves a different problem: Memory records *that* something
happened, scattered across individual entries — an agent starting a fresh session still has to
re-explore the codebase from scratch to learn "what does package X do." Dreaming closes that
loop by maintaining a standing, searchable summary of the project itself, so any agent on any
machine can `tsq kb search` instead of rediscovering the same things every session.

## KB storage

The knowledge base lives at `<work_dir>/tsq/kb/**/*.md`, **committed to git** — not
`.tsq/`, which is gitignored and used for local-only state like [local memory](./memory#scope-local-vs-global).
This is deliberate: the KB is meant to be reviewed in a PR diff like any other project artifact,
and to travel between machines the same way the rest of the codebase does, with no server-side
sync required.

Each file mirrors the real directory layout — one short file per package or module, e.g.
`tsq/kb/packages/daemon/supervisor.md` for `packages/daemon/supervisor/`. Every file has
frontmatter (`title`, `tags`) plus a short prose body covering the module's responsibility and
key APIs — dense enough to be useful, short enough to stay in context.

## Two-phase lifecycle

Building and maintaining the KB is split into two distinct processes:

1. **`tsq kb init`** — user-triggered, one-time bootstrap. Run it once in a project to generate
   the initial `tsq/kb/` tree from scratch. To keep any single agent's context small, it fans out
   to a sub-agent per top-level directory (or per `packages/*` entry in a monorepo) rather than
   summarizing the whole repo in one pass.
2. **Dreaming** — automatic, nightly, and incremental. Once a KB exists, the daemon picks a
   random time inside a configured night window and spawns a background session that reads
   *today's* Memory rollup and makes small, targeted edits to the specific `tsq/kb/*.md` files
   each fact touches — never reloading the whole tree — then commits and pushes.

Dreaming only runs once a KB already exists in the project (`tsq/kb/` is non-empty). It never
auto-bootstraps one; that first creation is always a deliberate `tsq kb init`.

## Configuration

Dreaming is configured via an optional `[dreamer]` section in `~/.tasksquad/config.toml`, the
same pattern as `[supervisor]`:

```toml
[dreamer]
command      = "claude"   # optional — falls back to [supervisor]'s command if unset
window_start = "01:00"    # start of the nightly trigger window (local time)
window_end   = "05:00"    # end of the nightly trigger window
```

Resolution order:

- `[dreamer].command` set → used directly.
- `[dreamer].command` unset but `[supervisor].command` is set → Dreaming borrows the supervisor's
  CLI.
- Neither is configured → Dreaming is disabled entirely for that daemon.

The trigger time is picked once per project per day, inside the configured window, and stays
fixed even across a daemon restart mid-night — so a restart can't double-fire or reroll the
schedule.

## Distributed safety

Multiple teammates can have the same project checked out with Dreaming enabled on each of their
machines. Only one of them should actually dream a given project on a given night — otherwise
you'd get duplicate commits and duplicate summary entries. This is enforced with a small
server-side claim, idempotent per `(team, project, night)`: the first daemon to claim a project
for tonight wins, and every other daemon's claim attempt no-ops and skips. The knowledge base
content itself never touches the server — git remains the actual cross-machine transport, the
same as any other file in the repo.

## Prompt injection

Two independent things get added to a task prompt, and it's worth being precise about which is
which:

- The **daily Memory rollup** is injected into every task prompt automatically whenever the
  team's Memory setting is on and a rollup exists for today — this is existing [Memory](./memory)
  behavior, unchanged by Dreaming.
- A short **"knowledge base available" note** is injected whenever `tsq/kb/` happens to be
  non-empty, independent of the team's Memory setting. This note only reports that
  `tsq kb search <query>` is available — it has no awareness of Dreaming and fires identically
  whether `tsq/kb/` was populated by last night's Dreaming run or by `tsq kb init` alone with
  Dreaming disabled entirely.

Dreaming itself is never injected into a prompt. It only ever runs as a background job that reads
the rollup and writes `tsq/kb/` files — it has no live-session presence of its own.

## Where results show up

Dreaming doesn't introduce a new UI. Each night it runs, it pushes a normal global
[Memory](./memory) entry (category `events`, tagged `dreaming, kb`) summarizing what it changed
and why — visible on the existing **Memory** page in the Portal alongside every other memory
entry on the team.

## References

- [Memory](./memory) — The daily rollup Dreaming reads, and the mechanism it uses to record its
  own summary.
- [Available Skills](./skills) — `tsq-kb-builder` and `tsq-dreaming`, the two skills that drive
  this lifecycle.
- [Daemon CLI Reference](../api/daemon-cli) — `tsq kb search` and `tsq kb init` command reference.

---
name: tsq-end-session-memory
description: Extract and save project memory (facts, decisions, conventions) before a TaskSquad session closes
---

This session is closing. Before it ends, reflect on what happened and save any memory-worthy facts about the project — not reusable procedures (that's `/tsq-end-session-learning`), but *facts*: things a teammate or another agent working on this project would benefit from knowing.

## Your task

Review this session against each of the 5 memory categories below. For each one, decide: **nothing** (the common case — most sessions produce a memory-worthy fact in zero or one category, rarely more), a **local** entry, or a **global** entry.

## The 5 categories

- **personal** — facts about the people involved (who owns what area, who to ask about X)
- **preferences** — team/user conventions and stated preferences (code style, tools, workflow choices)
- **structure** — where things live (directory layout, file naming, module boundaries)
- **architecture** — design decisions and why (why X over Y, how a subsystem works)
- **events** — notable things that happened (a migration ran, a dependency was upgraded, an incident occurred)

## Scope: local vs global

Every entry you decide to save also needs a scope:

- **global** — project-wide facts a teammate or another agent (possibly on a different machine) would benefit from: architecture decisions, structure changes, team conventions, notable events. Pushed to the team's shared memory in the cloud.
- **local** — facts tied specifically to *this* machine or environment: a local port conflict, a personal shortcut, an environment-specific workaround. Never leaves this machine.

When in doubt, ask: "would this be useful to an agent running on a teammate's laptop?" Yes → global. No, this is specific to this checkout or machine → local.

## What does NOT qualify

- Trivial, obvious, or already-documented facts
- Anything that's really a reusable *procedure* — that belongs in `/tsq-end-session-learning`, not here
- One-off task details that won't matter next session
- **A daily/weekly "what happened today" summary.** Do not attempt this. An in-session skill only sees this one session, never the whole team's activity for the day — producing a team-wide rollup here would be structurally wrong, not just unnecessary. That rollup is a separate server-side mechanism that runs on a schedule with visibility across every agent's session; leave it alone.

## Good vs bad examples

**Good** (architecture / global):
```
title: Session transcripts stored in R2, not D1
category: architecture
tags: storage, transcripts

Full session transcripts are uploaded encrypted to R2 rather than stored in D1,
to keep D1 rows small. See packages/worker/src/routes/daemon.ts.
```

**Good** (structure / global):
```
title: Local install layout is shared across skills/agents/commands
category: structure
tags: cli, conventions

Skills, sub-agents, and commands all install to <work_dir>/.tsq/<kind>/<name>/.
A new install-type should follow the same layout rather than inventing a new one.
```

**Good** (personal / local — machine-specific, not useful to teammates):
```
title: Local dev uses a forked tsq binary
category: personal
tags: local-setup

This checkout runs a personal fork of the CLI at ~/dev/tsq-fork for testing —
don't assume the published binary when debugging CLI behavior here.
```

**Bad** (too trivial, don't save):
```
Ran `npm install` to install dependencies.
```

**Bad** (this is a skill, not memory — push it with `tsq skill` instead):
```
To apply a D1 migration remotely, run `wrangler d1 migrations apply --remote`.
```

## Saving a local entry

Use your own Write tool directly — no CLI round-trip needed, since local memory lives inside your own work_dir and never touches the network. Write to:

```
.tsq/memory/<category>/<YYYY-MM-DD>-<kebab-slug-of-title>.md
```

With frontmatter:

```markdown
---
title: <short title>
category: <one of the 5 categories>
date: <YYYY-MM-DD>
tags: tag-one, tag-two
---

<markdown content — the fact itself, with enough context to be useful later>
```

## Saving a global entry

Write the content to a temp file, then push it with `tsq memory push`:

```bash
# 1. Write memory content to a temp file
cat > /tmp/tsq-memory-entry.md << 'EOF'
---
title: <short title>
category: <one of the 5 categories>
tags: tag-one, tag-two
---

<markdown content>
EOF

# 2. Push to the daemon
tsq memory push \
  --scope    global \
  --category <one of: personal | preferences | structure | architecture | events> \
  --title    "<short title>" \
  --tags     "tag-one,tag-two" \
  --file     /tmp/tsq-memory-entry.md
```

A `HTTP 200: {"id":"...","title":"..."}` response means it was saved successfully.

## Searching existing memory

If you need to check whether something is already known before saving a duplicate, search both scopes at once:

```bash
tsq memory search "<query>"
```

Results are tagged `[local]` or `[global]` so you know where each fact came from.

## When done

After saving all memory-worthy items (or if there are none), respond with a brief summary:
- "Saved N memory item(s): X local, Y global" if you saved something
- "No memory-worthy items this session." if nothing qualified

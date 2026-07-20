-- Migration number: 0042 	 2026-07-14T02:15:03.118Z

-- One-off content seed (NOT a schema migration). Delivered via the same
-- seed-then-execute-then-delete workflow already used for
-- 0041_system_attach_skill.sql, described in
-- packages/portal/src/docs/concepts/dreaming.md: run once with
-- `bunx wrangler d1 execute tasksquad-db --remote --file=<this file> -y`, confirm
-- it applied, then delete this file. is_default=1 rows sync to every agent
-- regardless of team (see userSkills in routes/skills.ts and the daemon's
-- syncAgentSkills), which is how `tsq-kb-builder` reaches every project without a
-- per-team install step. Dispatches the `kb-directory-summarizer` sub-agent
-- (0044_kb_summarizer_sub_agent.sql) once per top-level directory.
INSERT INTO skills (id, team_id, name, description, content, author_id, etag, is_default, auto_install, version, created_at, updated_at)
VALUES (
  '01K15XG81EDHX74YH34344B8N4',
  NULL,
  'tsq-kb-builder',
  'One-time bootstrap protocol that builds a project''s tsq/kb/ knowledge base from scratch by dispatching a summarizer sub-agent per top-level directory',
  '---
name: tsq-kb-builder
description: One-time bootstrap protocol that builds a project''s tsq/kb/ knowledge base from scratch by dispatching a summarizer sub-agent per top-level directory
---

## When to use

Triggered by `tsq kb init`. Runs once per project — the goal is a complete but lightweight
`tsq/kb/` tree, not an exhaustive audit. If `tsq/kb/` already has content, this is the wrong
skill: prefer `/tsq-dreaming`''s incremental, fact-by-fact approach instead of re-running a full
bootstrap.

## Step 1 — Find the unit of work

Determine what counts as a "top-level directory" for this project:

- If a `packages/` directory exists, treat each `packages/<name>` as one unit (this mirrors a
  monorepo layout like `packages/daemon`, `packages/worker`, `packages/portal`).
- Otherwise, treat each top-level directory as one unit, excluding `node_modules`, `.git`, hidden
  directories, `tsq/` itself, and build output directories (`dist`, `build`).

Keep the list short and meaningful. Skip directories that are empty or pure build output — there''s
nothing to summarize.

## Step 2 — Dispatch one sub-agent per unit

For each unit, invoke the `kb-directory-summarizer` sub-agent via the Task tool with a prompt
scoped to **just that directory** — its path, and nothing else. Do not paste the whole repo tree
or other directories'' contents into its prompt. The entire point of doing this per-directory,
rather than one pass over the whole repo, is to keep each sub-agent''s context small and its
summary focused on what it actually read.

## Step 3 — Write each summary to disk

Each sub-agent returns a structured summary (title, responsibility, key exports/APIs, suggested
tags). Write it to:

```
tsq/kb/<path-to-directory>/<name>.md
```

mirroring the real directory path — e.g. a summary of `packages/daemon/supervisor` becomes
`tsq/kb/packages/daemon/supervisor.md`. Use this frontmatter shape:

```markdown
---
title: <short title>
tags: tag-one, tag-two
---

<short prose: what this directory/module is responsible for, and its key exported
functions/APIs/types>
```

## Step 4 — Commit and push

Once every unit has a file:

```bash
git add tsq/kb
git commit -m "Initial knowledge base"
git push
```

## When done

There''s no task ID to report a verdict against — this print-mode session isn''t attached to a
portal task the way a normal session is. No `tsq report` call is needed; the session simply exits
once the commit is pushed. Respond with a brief summary: how many directories were summarized and
confirmation that the commit was pushed.
',
  NULL,
  '',
  1,
  1,
  1,
  (unixepoch() * 1000),
  (unixepoch() * 1000)
);

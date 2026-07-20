-- Migration number: 0043 	 2026-07-14T02:15:07.442Z

-- One-off content seed (NOT a schema migration). Same seed-then-execute-then-delete
-- workflow as 0041_system_attach_skill.sql and 0042_tsq_kb_builder_skill.sql —
-- run once via `bunx wrangler d1 execute tasksquad-db --remote --file=<this file> -y`,
-- confirm, then delete this file. is_default=1 syncs to every agent regardless of
-- team. This is the skill the daemon's Dreamer package (see
-- packages/portal/src/docs/concepts/dreaming.md) loads into the nightly print-mode
-- session it spawns after winning a project's dream-run claim.
INSERT INTO skills (id, team_id, name, description, content, author_id, etag, is_default, auto_install, version, created_at, updated_at)
VALUES (
  '01KPW8QZXYNE1Y932D30BZNVV5',
  NULL,
  'tsq-dreaming',
  'Nightly incremental protocol that keeps an existing tsq/kb/ knowledge base current by walking today''s Memory rollup fact-by-fact',
  '---
name: tsq-dreaming
description: Nightly incremental protocol that keeps an existing tsq/kb/ knowledge base current by walking today''s Memory rollup fact-by-fact
---

This session is running unattended, triggered automatically by the daemon inside the configured
`[dreamer]` night window. Today''s Memory daily-rollup content has already been injected into this
session''s initial prompt — do not attempt to re-fetch it via `tsq memory search` or any other
call; it is already in front of you.

## Your task

Walk the rollup **one fact/bullet at a time**. For each fact, decide whether it changes anything
an agent reading `tsq/kb/` would want to know. Most days produce **zero or one** relevant KB
change — that''s the common case, not a failure. Do not force a change per fact, and do not attempt
to compress the whole day into one sweeping rewrite.

For each fact that does matter:

1. Use `tsq kb search <keywords>` (or `grep -r` over `tsq/kb/` if search comes up empty) to find
   which existing KB file(s) it should update. If nothing matches well, consider whether it
   belongs in an existing nearby file before creating a new one — the KB should stay a small set
   of focused files, not grow one file per fact.
2. Make a **small, targeted edit** to just that file — add or revise a sentence, not a rewrite.
   Never reload the whole `tsq/kb/` tree into context; you only need the one or two files a given
   fact actually touches.
3. Move on to the next fact.

## Committing your changes

Once you''ve walked the whole rollup:

```bash
git add tsq/kb
git commit -m "Dreaming: <short summary of what changed>"
```

Then sync with the remote:

```bash
git pull --rebase --autostash && git push
```

If the push fails or the rebase conflicts, retry the pull-rebase-push sequence **once**. If it
fails a second time, stop — leave the commit local and say so plainly in your final summary rather
than looping. A stuck rebase left overnight is worse than a commit that waits for a human to
resolve it.

## Recording what happened

Finish by pushing a summary through the existing global Memory mechanism — this is the durable,
human-visible record of tonight''s run, shown on the Portal''s Memory page:

```bash
# 1. Write a short summary to a temp file
cat > /tmp/tsq-dreaming-summary.md << ''EOF''
<1-3 sentences: which tsq/kb/ files changed and why>
EOF

# 2. Push it
tsq memory push \
  --scope    global \
  --category events \
  --title    "<short title, e.g. ''Dreaming: updated supervisor KB entry''>" \
  --tags     "dreaming,kb" \
  --file     /tmp/tsq-dreaming-summary.md
```

If nothing in the rollup was KB-worthy, still push a short entry saying so (e.g. "Dreaming: no KB
changes tonight"). A record of "checked, nothing to do" is as useful as a record of a change when
someone is later auditing whether Dreaming ran at all.

## When done

There''s no task ID to report against — this session isn''t attached to a portal task. No `tsq
report` call is needed; the print-mode session exits once the `tsq memory push` call above
completes.
',
  NULL,
  '',
  1,
  1,
  1,
  (unixepoch() * 1000),
  (unixepoch() * 1000)
);

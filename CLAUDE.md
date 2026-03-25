# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

> **Public repo** — never commit secrets, tokens, or credentials.

@AGENTS.md

## Skills

Project-specific skills live in `.tsq/skills/` and are symlinked into `.claude/skills/`.
Skills are for **complex, multi-step flows** — API call sequences, non-obvious tool patterns. Not for trivial tasks.
Each skill directory contains a `SKILL.md` (or `SKILL.mk`) loaded on demand.

| Skill | Trigger |
|-------|---------|
| `tsq-cli-commands` | Working on daemon, debugging tasks, configuring `tsq` |
| `tsq-daemon-e2e-testing` | End-to-end testing locally or on production |
| `browser-use` | Web automation, form filling, screenshots |
| `release_notes_twitter` | Posting release updates to `@Task_Squad_ai` |
| `makefile` | Running, testing, deploying via `make` targets |
| `image-and-video-gen-xskills` | Generating videos with Seedance / xskill.ai |
| `video-concatination` | Stitching existing video segments with ffmpeg |

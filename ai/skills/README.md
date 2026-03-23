# AI Skills — Single Source of Truth

This directory is the canonical location for all project dev skills.
Each AI tool's skills directory is a symlink here — do **not** edit skills in the tool-specific directories.

## Symlinks

`.claude/`, `.agents/`, `.opencode/` are gitignored (they hold machine-local config).
The symlinks live locally — run this once after cloning:

```bash
ln -sf "$(pwd)/ai/skills" .claude/skills
ln -sf "$(pwd)/ai/skills" .agents/skills
ln -sf "$(pwd)/ai/skills" .opencode/skills
```

| AI Tool | Path | Points to |
|---------|------|-----------|
| Claude Code | `.claude/skills/` | `ai/skills/` |
| Agents / Codex | `.agents/skills/` | `ai/skills/` |
| OpenCode | `.opencode/skills/` | `ai/skills/` |

## Adding a New Skill

1. Create `ai/skills/<skill-name>/SKILL.md` (use frontmatter: `name`, `description`)
2. All tools pick it up automatically via their symlinks — no copy needed

## Adding a New AI Tool

```bash
ln -s ../ai/skills .<tool-name>/skills
```

Commit the symlink. Symlinks are tracked by git; they resolve correctly on macOS/Linux.
On Windows, enable `git config core.symlinks true` before cloning.

## Skills Index

| Skill | Description |
|-------|-------------|
| `browser-use` | Browser automation via `browser-use` CLI |
| `image-and-video-gen-xskills` | Video generation via Seedance / xskill.ai |
| `makefile` | Run, test, deploy via `make` targets |
| `release_notes_twitter` | Post release notes to `@Task_Squad_ai` on Twitter |
| `tsq-cli-commands` | `tsq` daemon CLI reference |
| `tsq-daemon-e2e-testing` | E2E testing guide (local + production) |
| `video-concatination` | Stitch video segments with ffmpeg |

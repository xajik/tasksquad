# GEMINI.md

This file provides guidance to Gemini CLI when working in this repository.

> **Public repo** — never commit secrets, tokens, or credentials.

See **AGENTS.md** for the full development guide: commands, infrastructure, DB schema, API routes, code style, and implementation status.

## Gemini-Specific Notes

- Use `make dev` in each package to start local services before testing
- Run E2E tests via the `tsq-daemon-e2e-testing` skill (loaded from `ai/skills/`)
- For live browser testing, use `browser-use` skill with `--headed` flag

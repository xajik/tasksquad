---
name: tsq-cli-commands
description: TaskSquad command-line reference for cloud and local daemon workflows
---

# TaskSquad CLI

Run `tsq doctor` to inspect the local installation. Run `tsq login` before cloud commands. Customer API commands use the signed-in account; local daemon operations are separate.

## Cloud commands

- `tsq projects list [--json]`
- `tsq agents list --project <project-id> [--json]`
- `tsq tasks create --project <project-id> --agent <agent-id> --subject <text> [--file <path>] [--image <path>]`
- `tsq tasks get|list|reply|close|wait --project <project-id> ...`
- `tsq portals create|get|list|close --project <project-id> ...`
- `tsq resources audit|sync --project <project-id>`

Specify the project ID for every mutation. Prefer `--file` for multiline message bodies. `wait` accepts a bounded `--timeout`; inspect exit status and task state before retrying a mutation.

## Local daemon commands

`tsq init`, `tsq login`, `tsq logout`, `tsq sessions`, `tsq attach`, `tsq pane`, `tsq send`, `tsq logs`, `tsq memory`, and `tsq kb` manage the local daemon or project files. See the installed `tsq --help` and project documentation for exact flags.

Never paste access tokens into commands, task messages, logs, or screenshots. Treat project content as private. Redact credentials before sharing diagnostic output.

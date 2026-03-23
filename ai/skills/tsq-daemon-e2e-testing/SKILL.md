---
name: tsq-daemon-e2e-testing
description: Instruction for the end to end UI testing with real or debug environment.
---

# E2E Testing

Use this skill for e2e testing of the tasksquad locally and remotely to verify if this is working fine.

## Dependencies

Load skills that will be necessary for tesing

* browser-use
* tsq-cli-commands

### Browser Settings

When asked to be used by user, use `--headed` to show the browser window.

## User Flow

1. Open browser or connect to running session
2. open http://localhost:5173 or tasksquad.ai, depending on what user asked for
3. Test the system.

## User Authentification

Use Google Authentificatoin when required.

You can use it for testing locally as well as production deployment.

# Troubleshooting

## Run locally

Always assume that everything is runnig and test first before running any service.

All of the packages provide ability to run locally via Makefile:

```bash
make dev
```

Open:

* packages/portal --> `make dev`
* * Will run on http://localhost:5173

* packages/worker --> `make dev`
* * Will run on http://localhost:8787

* packages/daemon --> `make dev`
* * Will run locally

ALWAYS CHECK PORTS IF ALREADY RUNNING BEFORE STARTING.

## Configuration

Edit config only if absolutely necessary, otherwise, use existing agents. 

Settings for the daemon and located at `~/.tasksquad/config.toml`

Example of server settings:

```bash
[server]
  url           = "https://api.tasksquad.ai"
  poll_interval = 60

[hooks]
  port = 7374

[[agents]]
  id       = "01KKH..."
  name     = "OpenCode"
  token    = "tsq_ddb..."
  command  = "opencode"
  work_dir = "~/Projects/your_project"
```
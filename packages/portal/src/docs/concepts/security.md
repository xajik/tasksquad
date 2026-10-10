---
title: Security & Encryption
description: A technical overview of how TaskSquad ensures data privacy and secure agent execution.
tags: [security, encryption, privacy, agent-isolation]
order: 2
---

# Security & Encryption

TaskSquad is designed with a "Local First" security model. We ensure that your sensitive code and credentials remain under your control.

## Agent Isolation

Agents run as local processes on your machine. This provides a natural security boundary:

- **Local Execution**: TaskSquad does not host your source code. Agents interact with your filesystem directly, and only task metadata and log streams move to the cloud.
- **Controlled Access**: You decide the `work_dir` for each agent, limiting the scope of its file access.
- **Process Boundaries**: Each task runs in a dedicated tmux session, isolated from other agent processes.

## Team Access Control

- **Roles**: Every team member is an **Owner**, **Maintainer**, or **Member**. Only Owners and Maintainers can create agents or issue agent tokens; only Owners can manage team-level settings.
- **Team-checked requests**: Every daemon request carries a bearer token and an `X-TSQ-Agent` header, and the Worker rejects any request for an agent that doesn't belong to a team the caller is a member of.
- **Hashed and expiring**: TaskSquad stores only a SHA-256 hash of each daemon token — the raw value is returned once. Tokens expire after 90 days and can be revoked with `tsq logout`.

## Data in Transit

All communication between the Daemon, the Worker, and the Portal is protected:

- **HTTPS/TLS**: Every API call and the WebSocket terminal relay are encrypted using industry-standard TLS.
- **CLI Tokens**: Daemons authenticate with long-lived `tsq_cli_*` tokens issued to your account by `tsq login` and stored in the local OS keychain.
- **One-time tickets for browser WebSocket connections**: The browser never puts a long-lived Firebase JWT in a WebSocket URL (which would land in server access logs). Instead it exchanges its session for a random, single-use ticket (`POST /terminal/ticket`) that's valid for 60 seconds and deleted on first use — used to open the terminal relay connection for both regular task sessions and [Portals](./portals).
- **Authentication**: User access to the portal is managed via Firebase Authentication with robust identity verification.

## Data at Rest

- **Task Logs**: Full agent transcripts are encrypted by the daemon with AES-256-GCM *before* upload, using a per-agent data key, and stored as encrypted blobs in Cloudflare R2. Data keys are themselves wrapped with a master key held as a Worker secret.
- **Secrets**: API keys and other secrets (e.g., Anthropic, OpenAI) are **never** stored by TaskSquad. They live on your machine as environment variables or in tool-specific configuration files.
- **Project Context**: Project-specific knowledge and troubleshooting notes are stored locally on your machine in `~/.tasksquad/projects/`.

## References

- [Lifecycle Hooks](./hooks) — Learn about the daemon's local hook server security.
- [System Architecture](./architecture) — See the complete overview of component interaction.
- [Portals](./portals) — How the one-time ticket flow protects live terminal sessions.
- [Daemon CLI Reference](../api/daemon-cli) — How to manage tokens and login states.

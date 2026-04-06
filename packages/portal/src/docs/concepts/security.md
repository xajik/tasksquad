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

## Data in Transit

All communication between the Daemon, the Worker, and the Portal is protected:

- **HTTPS/TLS**: Every API call and Server-Sent Events (SSE) stream is encrypted using industry-standard TLS.
- **CLI Tokens**: Daemons authenticate with long-lived `tsq_cli_*` tokens that are scoped to specific agents and stored securely in the local OS keychain.
- **Authentication**: User access to the portal is managed via Firebase Authentication with robust identity verification.

## Data at Rest

- **Task Logs**: Full agent output streams are stored as encrypted blobs in Cloudflare R2.
- **Secrets**: API keys and other secrets (e.g., Anthropic, OpenAI) are **never** stored by TaskSquad. They live on your machine as environment variables or in tool-specific configuration files.
- **Project Context**: Project-specific knowledge and troubleshooting notes are stored locally on your machine in `~/.tasksquad/projects/`.

## References

- [Lifecycle Hooks](./hooks) — Learn about the daemon's local hook server security.
- [System Architecture](./architecture) — See the complete overview of component interaction.
- [Daemon CLI Reference](../api/daemon-cli) — How to manage tokens and login states.

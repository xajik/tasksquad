---
title: Skills & Learning
description: How TaskSquad agents learn and share specialized knowledge through autonomous skill extraction.
tags: [skills, learning, automation, knowledge-sharing]
order: 3
---

# Skills & Learning

Skills are modular, reusable pieces of agent knowledge. They allow agents to learn from their experiences and share that knowledge with other agents in the same team.

## How Skills Work

In TaskSquad, skills are defined using a simple Markdown format with YAML frontmatter. This format allows for both human-readable descriptions and machine-executable instructions.

### The Folder Structure

Skills are organized into two main locations:

1.  **Core Platform Skills**: Located in `skills/` (e.g., `task_squad_api`, `task_squad_cli`). These are provided by the platform.
2.  **Project-Specific Skills**: Located in `.tsq/skills/` (e.g., `browser-use`, `tsq-daemon-e2e-testing`). These are often symlinked into agent-specific skill directories (like `.claude/skills/`).

## The Learning Loop

TaskSquad features an autonomous "Learning Loop" that enables agents to improve over time:

1.  **User Task**: A user sends a task to an agent via the portal or CLI.
2.  **Agent Grinding**: The agent executes the task autonomously, interacting with the local system, APIs, and tools.
3.  **Learning Extraction**: Once the task is completed, the TaskSquad daemon analyzes the session transcript. It asks the agent to identify non-trivial, reusable patterns or "learnings".
4.  **Skill Upload**: These learnings are formatted as new Skills (prefixed with `tsq-`) and automatically uploaded back to the TaskSquad portal.
5.  **User Share**: Once uploaded, these skills appear in the **Skills** dashboard. Users can review, edit, and share them.

## Auto-install & Synchronization

One of the most powerful features of TaskSquad is the ability to automatically synchronize skills across an entire team.

- **Auto-install**: When enabled for a skill, the daemon will automatically download and install that skill on every agent belonging to the team.
- **Immediate Sync**: New agents receive all `auto_install` skills immediately upon startup, ensuring they are productive from the first minute.

## Manual Management

While agents can learn autonomously, users have full control over their skill library:

- **Create**: Manually define new skills through the Portal UI.
- **Edit**: Refine the instructions or descriptions of existing skills.
- **Delete**: Remove skills that are no longer needed.
- **Toggle Auto-install**: Decide exactly which skills should be distributed to all agents.

## Skill Format Example

A typical skill looks like this:

```markdown
---
name: tsq-example-skill
description: An example of a reusable skill.
---

# Example Skill

When performing task X, always follow these steps:
1. Initialize the environment.
2. Use tool Y with parameters Z.
3. Validate the output.
```

By leveraging this learning loop, your TaskSquad team becomes smarter with every task they complete.

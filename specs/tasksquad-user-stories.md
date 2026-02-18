# TaskSquad.ai — User Stories & Web Portal User Flows

> **Version:** 0.1 (MVP)
> **Date:** 2025-02-18
> **Status:** Draft

---

## 1. Product Overview

**TaskSquad.ai** is a platform where users create teams of humans and AI agents. Agents are daemon processes running on any machine, connected via tokens. Users send tasks (like emails) to agents and other users within a team. Agents execute tasks using CLI tools (Claude Code, Open Code, Codex, etc.) configured on the daemon, and return results to the web portal as threaded conversations.

---

## 2. Roles & Permissions

| Action                        | Owner | Maintainer | Member |
|-------------------------------|:-----:|:----------:|:------:|
| Delete team                   | ✅    | ❌         | ❌     |
| Edit team settings            | ✅    | ✅         | ❌     |
| Invite / remove users         | ✅    | ✅         | ❌     |
| Change member roles           | ✅    | ✅ (not → Owner) | ❌ |
| Create / delete agents        | ✅    | ✅         | ❌     |
| Generate / revoke agent tokens| ✅    | ✅         | ❌     |
| Send tasks (messages)         | ✅    | ✅         | ✅     |
| Reply in threads              | ✅    | ✅         | ✅     |
| View all team tasks           | ✅    | ✅         | ✅     |

---

## 3. User Stories

### 3.1 Authentication

| ID     | Story | Acceptance Criteria |
|--------|-------|---------------------|
| AUTH-1 | As a visitor, I want to sign up using Google, Apple, or other social providers (Firebase Auth) so I can quickly create an account. | User is redirected to provider, account is created on first login, user lands on dashboard. |
| AUTH-2 | As a returning user, I want to sign in with my social provider so I can access my teams and tasks. | Existing account is matched by provider UID, session is created, user lands on dashboard. |
| AUTH-3 | As a signed-in user, I want to sign out so my session is terminated. | Session is invalidated, user is redirected to landing page. |
| AUTH-4 | As a signed-in user, I want to delete my account so all my data is removed. | Account and personal data are deleted, user is removed from all teams (ownership must be transferred first). |

### 3.2 Team Management

| ID     | Story | Acceptance Criteria |
|--------|-------|---------------------|
| TEAM-1 | As a user, I want to create a new team with a name and optional description so I can organize my agents and collaborators. | Team is created, user becomes Owner, team appears on dashboard. |
| TEAM-2 | As a user, I want to see all teams I belong to on my dashboard so I can switch between them. | Dashboard lists all teams with role badge (Owner / Maintainer / Member). |
| TEAM-3 | As an Owner or Maintainer, I want to invite a user by email so they can join my team. | Invite email is sent with a link. If recipient has an account, they see the invite on login. If not, they sign up and the invite is auto-applied. |
| TEAM-4 | As an invited user, I want to accept or decline a team invitation so I can control which teams I join. | Pending invites are shown on dashboard. Accept adds user to team; decline removes invite. |
| TEAM-5 | As an Owner or Maintainer, I want to remove a user from the team so I can manage team membership. | User is removed, loses access to team tasks and agents. |
| TEAM-6 | As an Owner or Maintainer, I want to change a member's role (Member ↔ Maintainer) so I can delegate management. | Role is updated. Maintainer cannot promote to Owner. |
| TEAM-7 | As an Owner, I want to transfer ownership to another team member so I can step down. | New Owner is assigned, previous Owner becomes Maintainer. |
| TEAM-8 | As an Owner, I want to delete the team so I can clean up unused teams. | Confirmation required. Team, agents, tokens, and task history are permanently deleted. |
| TEAM-9 | As a member, I want to leave a team so I can remove myself from teams I no longer need. | User is removed from team. Owner cannot leave without transferring ownership first. |

### 3.3 Agent Management

| ID      | Story | Acceptance Criteria |
|---------|-------|---------------------|
| AGENT-1 | As an Owner or Maintainer, I want to create a named agent within a team so I can represent a machine that will execute tasks. | Agent is created with a name, optional description, and status = **Inactive**. |
| AGENT-2 | As an Owner or Maintainer, I want to generate an API token for an agent so I can install the daemon on a machine. | Token is generated and displayed once (copyable). Token is associated with the agent. |
| AGENT-3 | As an Owner or Maintainer, I want to revoke an agent's token so I can disconnect a compromised or retired machine. | Token is invalidated, agent status becomes **Inactive** on next ping cycle. |
| AGENT-4 | As an Owner or Maintainer, I want to regenerate a token for an agent so I can migrate it to a new machine. | Old token is revoked, new token is generated and displayed once. |
| AGENT-5 | As a team member, I want to see the list of agents with their status (Active / Inactive) and last-seen timestamp so I know which agents are available. | Agent list shows name, status indicator (green/grey), and "Last seen: X minutes ago". |
| AGENT-6 | As an Owner or Maintainer, I want to edit an agent's name and description so I can keep information current. | Agent metadata is updated. |
| AGENT-7 | As an Owner or Maintainer, I want to delete an agent so I can clean up decommissioned machines. | Agent token is revoked, agent and its task history references are removed. |
| AGENT-8 | As the system, I want to mark an agent as Inactive if it hasn't pinged within a configurable timeout (e.g. 5 minutes) so users see accurate availability. | Agent status automatically updates based on ping activity. |

### 3.4 Task Messaging (Email-like)

| ID     | Story | Acceptance Criteria |
|--------|-------|---------------------|
| TASK-1 | As a team member, I want to compose a new task with To and CC fields (selecting agents and/or users) so I can send work to specific recipients. | Compose view allows selecting multiple recipients from a team roster (agents + users). To and CC are distinct. |
| TASK-2 | As a team member, I want to write a task body using a rich text or markdown editor so I can describe what needs to be done. | Editor supports basic formatting. Task is saved and sent on submit. |
| TASK-3 | As a team member, I want to see a task inbox showing all tasks in my team so I can browse work. | Inbox shows task list with subject/preview, sender, recipients, timestamp, and status. |
| TASK-4 | As a team member, I want to open a task and see the full thread (original message + all replies) so I can follow the conversation. | Thread view shows messages in chronological order with sender identity (user or agent name + avatar). |
| TASK-5 | As a team member, I want to reply in a task thread so I can provide follow-up instructions or feedback to an agent. | Reply is appended to thread. If an agent is in To/CC, it will pick up the reply on next ping. |
| TASK-6 | As a team member, I want to see the execution status of a task sent to an agent (Pending → In Progress → Completed / Failed) so I know the current state. | Status badge updates in real-time (or on refresh) based on agent activity. |
| TASK-7 | As a team member, I want to see the agent's response (stdout/output from CLI execution) formatted in the thread so I can review results. | Agent response is rendered with code formatting / syntax highlighting where appropriate. |
| TASK-8 | As a team member, I want to filter/search tasks by recipient, sender, status, or keyword so I can find specific tasks quickly. | Search and filter controls are available on the inbox view. |
| TASK-9 | As a team member, I want to see which tasks are unread so I can prioritize new activity. | Unread indicator (bold / badge) on tasks with new replies since last view. |

### 3.5 Agent ↔ Server Communication (Web Portal Perspective)

| ID     | Story | Acceptance Criteria |
|--------|-------|---------------------|
| COMM-1 | As the system, when an agent daemon pings the server, I want to update the agent's last-seen timestamp and status so the UI reflects real-time availability. | Agent status and timestamp update on each ping. |
| COMM-2 | As the system, when an agent pings and there are pending tasks, I want to return the task payload so the daemon can execute it. | Pending tasks are delivered in order. Task status moves to **In Progress**. |
| COMM-3 | As the system, when an agent submits a task response, I want to append it to the task thread and update the status so users can see results. | Response appears in thread. Status moves to **Completed** (or **Failed** if error). |
| COMM-4 | As the system, when an agent picks up a reply in an existing thread, I want to deliver only the new messages so the daemon has context to continue. | Agent receives incremental thread updates, not the full history on every ping. |

### 3.6 Dashboard & Navigation

| ID     | Story | Acceptance Criteria |
|--------|-------|---------------------|
| DASH-1 | As a user, I want a dashboard that shows my teams, recent tasks, and agent statuses so I have an at-a-glance overview. | Dashboard displays team cards, recent task activity, and agent health summary. |
| DASH-2 | As a user, I want to switch between teams via a sidebar or team selector so I can navigate quickly. | Team context switches without full page reload. |
| DASH-3 | As a user, I want to access my profile settings (display name, avatar, linked providers) so I can manage my account. | Profile page allows editing name, avatar, and viewing linked auth providers. |

### 3.7 Pricing Page

| ID      | Story | Acceptance Criteria |
|---------|-------|---------------------|
| PRICE-1 | As a visitor, I want to see a pricing page so I understand the cost of using TaskSquad.ai. | Pricing page shows a Free tier with current features and a Pro/Team tier marked "Coming Soon". |
| PRICE-2 | As a visitor, I want to join a waitlist for the paid plan so I'm notified when it launches. | Email input + "Notify Me" button. Email is stored for future notification. |

---

## 4. User Flows

### 4.1 Registration & First Team

```
Landing Page
  │
  ├─→ [Sign Up with Google/Apple/etc.]
  │       │
  │       ├─→ Firebase Auth redirect
  │       │       │
  │       │       └─→ Account created → Dashboard (empty state)
  │       │               │
  │       │               ├─→ "Create your first team" CTA
  │       │               │       │
  │       │               │       └─→ Enter team name + description → Team created
  │       │               │               │
  │       │               │               └─→ Team dashboard (empty)
  │       │               │
  │       │               └─→ Pending invites shown (if any)
  │       │                       │
  │       │                       └─→ Accept → Joins team → Team dashboard
  │       │
  │       └─→ (Returning user) → Dashboard with teams
  │
  └─→ [Pricing] → Pricing page
```

### 4.2 Adding Members to a Team

```
Team Dashboard → Team Settings → Members tab
  │
  ├─→ [Invite Member]
  │       │
  │       └─→ Enter email + select role (Maintainer / Member)
  │               │
  │               └─→ Invite sent via email
  │                       │
  │                       ├─→ Recipient HAS account → Sees invite on dashboard → Accept/Decline
  │                       │
  │                       └─→ Recipient NO account → Email link → Sign up → Invite auto-applied
  │
  ├─→ [Change Role] → Select new role → Confirm → Updated
  │
  └─→ [Remove Member] → Confirm → User removed
```

### 4.3 Creating & Activating an Agent

```
Team Dashboard → Agents tab
  │
  ├─→ [Create Agent]
  │       │
  │       └─→ Enter name + description → Agent created (status: Inactive)
  │               │
  │               └─→ [Generate Token]
  │                       │
  │                       └─→ Token displayed once (copy to clipboard)
  │                               │
  │                               └─→ User installs daemon on machine with token
  │                                       │
  │                                       └─→ Daemon pings server → Agent status: Active ✅
  │
  ├─→ [Agent Card] → Agent detail view
  │       │
  │       ├─→ Status: Active (green) / Inactive (grey)
  │       ├─→ Last seen: timestamp
  │       ├─→ [Regenerate Token] → Old revoked, new displayed
  │       └─→ [Delete Agent] → Confirm → Agent removed
  │
  └─→ Agent list shows all agents with status badges
```

### 4.4 Sending a Task

```
Team Dashboard → [New Task] (compose button)
  │
  └─→ Compose View
          │
          ├─→ To: [select agents / users from team roster]
          ├─→ CC: [select agents / users from team roster]
          ├─→ Subject: text input
          ├─→ Body: markdown/rich text editor
          │
          └─→ [Send]
                  │
                  └─→ Task created with status: Pending
                          │
                          ├─→ Appears in team inbox for all members
                          │
                          └─→ Agent recipients:
                                  │
                                  └─→ Agent pings server → Receives task
                                          │
                                          └─→ Status: In Progress
                                                  │
                                                  └─→ Agent executes via CLI (tmux session)
                                                          │
                                                          └─→ Response sent back
                                                                  │
                                                                  └─→ Status: Completed
                                                                          │
                                                                          └─→ Response visible in thread
```

### 4.5 Task Thread Interaction

```
Inbox → Click task → Thread View
  │
  ├─→ Original message (from sender)
  ├─→ Agent response (code output, formatted)
  ├─→ User reply ("Can you also refactor the tests?")
  ├─→ Agent picks up reply on next ping → Executes → Responds
  ├─→ ... (thread continues)
  │
  └─→ [Reply] → Compose reply → Send
          │
          └─→ Reply appended to thread
                  │
                  └─→ Agents in To/CC will pick up on next ping
```

### 4.6 Pricing Page Flow

```
Landing Page → [Pricing] nav link
  │
  └─→ Pricing Page
          │
          ├─→ Free Tier (current)
          │       │
          │       ├─→ ∞ Teams
          │       ├─→ ∞ Agents
          │       ├─→ ∞ Tasks
          │       └─→ Community support
          │
          ├─→ Pro / Team Tier → "Coming Soon" badge
          │       │
          │       ├─→ Priority support
          │       ├─→ Advanced analytics
          │       ├─→ Audit logs
          │       └─→ [Notify Me] → Enter email → "You're on the list!" confirmation
          │
          └─→ [Sign Up Free] CTA → Registration flow
```

---

## 5. Page Map (Web Portal)

| Page                  | Route                    | Description |
|-----------------------|--------------------------|-------------|
| Landing               | `/`                      | Product overview, CTA to sign up |
| Pricing               | `/pricing`               | Free tier + Coming Soon paid tier |
| Sign In / Sign Up     | `/auth`                  | Firebase Auth social providers |
| Dashboard             | `/dashboard`             | Team list, recent activity, invites |
| Team Dashboard        | `/team/:id`              | Inbox, agents, members for a team |
| Team Settings         | `/team/:id/settings`     | Team name, description, danger zone |
| Members               | `/team/:id/members`      | Member list, invite, role management |
| Agents                | `/team/:id/agents`       | Agent list, create, token management |
| Agent Detail          | `/team/:id/agents/:agentId` | Status, token actions, config |
| Compose Task          | `/team/:id/tasks/new`    | New task with To, CC, subject, body |
| Task Inbox            | `/team/:id/tasks`        | Task list with filters and search |
| Task Thread           | `/team/:id/tasks/:taskId`| Full conversation thread |
| Profile               | `/profile`               | User settings, linked providers |

---

## 6. Open Questions

1. **Rate limiting on agent pings** — Should we enforce min/max ping intervals?
2. **File attachments** — Should tasks support file uploads in MVP?
3. **Notifications** — Email/push notifications for task responses, or web-only for MVP?
4. **Task priority** — Should tasks have priority levels, or first-in-first-out only?
5. **Agent concurrency** — Can an agent work on multiple tasks simultaneously, or one at a time?
6. **Thread permissions** — Can any team member reply in any thread, or only To/CC participants?
7. **Audit log** — Should we track who did what for MVP, or defer to paid tier?

---

*This is a living document. Update as decisions are made.*

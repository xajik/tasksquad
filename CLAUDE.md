# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Structure

Two distinct parts:

- **Root** — Product documentation: `tasksquad-user-stories.md` (MVP spec with user story IDs), `tasksquad-ui-proposal.jsx` (original single-file UI reference prototype), and `tasksquad.pdf` (full product doc).
- **`demo/`** — Vite + React 19 + TypeScript app. `demo/src/App.tsx` is the primary working file — it currently contains the full implementation as a single file (Landing, Pricing, Auth, Dashboard pages + all shared components + mock data).
- **`prototype/`** — Standalone HTML/JSX prototypes (reference only).

`tasksquad-ui-proposal.jsx` is the design source of truth. When building UI in `demo/`, implement from that reference.

## Demo App Commands

All commands run from `demo/` using **bun**:

```bash
bun dev          # Start dev server (HMR)
bun build        # Type-check + production build
bun lint         # ESLint
bun preview      # Preview production build
```

No test runner is configured.

## Demo App Architecture

- **Framework:** React 19, TypeScript ~5.9, Vite 7 (SWC plugin)
- **Entry:** `demo/src/main.tsx` → `demo/src/App.tsx`
- **Routing:** No router library — top-level `useState<Page>` in `App` with conditional rendering. Pages receive a `go: (p: Page) => void` prop.
- **Styling:** 100% inline styles. `index.css` is a minimal reset only.
- **State:** All interactive state lives in `Dashboard` (tasks, agents, members, compose modal, open task, etc.). Stateless pages (`Landing`, `Pricing`, `Auth`) only receive `go`.

## Design System (in `demo/src/App.tsx`)

The color palette is in a `const C = { ... }` object. Font families are separate string constants. Icons are JSX stored as properties of `const Ico = { ... }`.

```ts
// Colors (C)
ink, inkMuted, inkLight, surface, surfaceAlt
border, borderLight, accent, accentLight
green, greenLight, amber, amberLight, red, redLight

// Fonts
const font = "'DM Sans', -apple-system, sans-serif"
const mono = "'JetBrains Mono', monospace"
```

**Shared components** (all in `App.tsx`, all inline-styled):
- `StatusDot` — active/inactive indicator dot
- `Pill` — mono-font label badge with custom color/bg
- `Btn` — button with `variant: 'primary' | 'secondary' | 'ghost' | 'danger'` and `small` prop
- `Avatar` — colored square with initials
- `ComposeModal` — full-screen overlay for new task composition

Icons are **inline SVG only** — no icon library. Add new icons to the `Ico` object.

## Domain Types (in `App.tsx`)

```ts
type Page = 'landing' | 'pricing' | 'auth' | 'dashboard'
type Tab = 'inbox' | 'agents' | 'members' | 'settings'
type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed'
type Role = 'Owner' | 'Maintainer' | 'Member'

interface Task { id, subject, from, to, status, time, unread, thread: Msg[] }
interface Msg  { from, init, color, time, body, type: 'human' | 'agent' }
interface Agent  { id, name, active, lastSeen, desc }
interface Member { id, name, email, role, init, color }
interface Team   { id, name, role }
```

## Product Domain Model

TaskSquad.ai lets users build teams of humans + AI agents that communicate via an email-like task interface.

**Core entities:**
- **Team** — container for members, agents, and tasks; roles are Owner / Maintainer / Member
- **Agent** — daemon process on any machine, authenticated by a revocable token; status Active/Inactive based on ping heartbeat
- **Task** — email-like message with To + CC fields (recipients can be agents or users); has a threaded reply chain; statuses: `pending` → `in_progress` → `completed` / `failed`

**Agent communication loop:** daemon polls server → receives pending tasks → executes via CLI tool (Claude Code, Codex, etc.) → posts result back as a thread reply

## Pages & Routes

| Page | Route | Component |
|---|---|---|
| Landing | `/` | `Landing` |
| Pricing | `/pricing` | `Pricing` |
| Auth | `/auth` | `Auth` |
| Dashboard | `/dashboard` | `Dashboard` |
| Task inbox | `/team/:id/tasks` | `Dashboard` tab=inbox |
| Task thread | `/team/:id/tasks/:taskId` | `Dashboard` openTaskId set |
| Agents | `/team/:id/agents` | `Dashboard` tab=agents |
| Members | `/team/:id/members` | `Dashboard` tab=members |
| Team settings | `/team/:id/settings` | `Dashboard` tab=settings |
| Agent detail | `/team/:id/agents/:agentId` | not yet implemented |
| Profile | `/profile` | not yet implemented |

## User Story IDs

`AUTH-1–4`, `TEAM-1–9`, `AGENT-1–8`, `TASK-1–9`, `COMM-1–4`, `DASH-1–3`, `PRICE-1–2`

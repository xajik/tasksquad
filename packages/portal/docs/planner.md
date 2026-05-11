# Planner

**Status:** Shipped (v1)  
**Route:** `/dashboard/planner`

---

## Overview

The Planner coordinates multi-phase work across agents. Each phase becomes an inbox task executed by a designated harness agent. The Planner gates advancement automatically — it dispatches phases one at a time, waits for a pass/fail signal from the inbox grade, and either moves to the next phase or retries.

The Planner does **no work itself**. It sequences and gates.

---

## Core Concepts

| Term | Description |
|---|---|
| **Planner** | A named, ordered set of phases with shared defaults and a lifecycle status |
| **Phase** | One unit of work — maps to one inbox task sent to one harness agent |
| **Harness agent** | The agent daemon that executes the phase task (selected from the Agents list) |
| **Sub-agent** | The AI tool/skill loaded into the harness for this phase (from Sub-agents) |
| **Verdict** | Pass or fail for a phase — sourced from the inbox task grade (👍 = pass, 👎 = fail). Read-only in the Planner UI; set in the inbox |
| **Retry** | On failure, the current phase attempt is reverted and a new task is dispatched |
| **Supervisor step** | An optional auto-generated verification task; the agent must respond with `{ "meets_requirements": true/false }` |
| **Pause** | A flag that stops automatic advancement — the current phase finishes but the next is not dispatched until the user resumes |

---

## Statuses

### Planner

| Status | Meaning |
|---|---|
| `pending` | Created, first phase not yet dispatched |
| `running` | At least one phase is active |
| `completed` | All phases passed |
| `failed` | A phase exhausted its retries |

### Phase

| Status | Meaning |
|---|---|
| `pending` | Not yet started — waiting for the previous phase |
| `in_progress` | Inbox task is active |
| `completed` | Phase passed (verdict approved) |
| `failed` | Retries exhausted |
| `reverted` | Failed attempt — being retried |

---

## User Flows

### Create a Planner

1. Navigate to **Dashboard → Planner → New Planner**
2. Fill in name, optional description, max retries per phase
3. Select **Default sub-agent** and **Default harness** — phases inherit these unless overridden
4. Toggle **Auto-close all phases** to mark every phase task as auto-close (each phase can still override individually)
5. Add one or more phases in order — each with a name, optional agent overrides, and auto-close toggle
6. Click **Create**

On creation the Planner immediately dispatches Phase 1 as an inbox task.

### Phase Lifecycle

```
Phase dispatched → agent executes task
        │
    auto_close?
    ┌────┴────┐
   yes        no
    │          └── user grades task in inbox (👍 / 👎)
    └────┬────┘
         │
     supervisor_check?
     ┌────┴────┐
    no          yes
     │           └── supervisor task auto-dispatched
     │                    │
     │            JSON verdict parsed
     └────┬────┘
          │
      verdict = pass?
      ┌────┴────┐
     yes        no
      │          └── retry_count < max_retries?
      │              ┌────┴────┐
      │             yes        no → phase FAILED, planner FAILED
      │              └── revert + re-dispatch
      │
   paused?
   ┌────┴────┐
  yes        no → dispatch next phase (or mark planner COMPLETED)
   └── wait for Resume
```

### Pause and Resume

- Open a planner detail view and click **Pause**
- The current phase continues; the **next** phase will not start automatically
- Click **Resume** to continue — if the current phase is already complete, the next phase dispatches immediately

### Open a Linked Task

- Click the **→** icon next to any phase name to open that phase's inbox task
- On a failed phase, a **"View failed task"** link appears in red
- On the supervisor row, click **View task** to open the supervisor inbox task

### Grade the Planner

Click 👍 or 👎 on any planner card or detail header to record your overall verdict. This is independent of execution — it is a human quality signal. Clicking the active verdict again clears it.

---

## Verdict Sources

A phase verdict can arrive from three sources, handled automatically:

| Source | Trigger | Result |
|---|---|---|
| `inbox_grade` | User thumbs-up (👍) in the inbox | Pass — advance to next phase |
| `inbox_grade` | User thumbs-down (👎) in the inbox — even before the task is closed | Fail — triggers retry immediately, same as supervisor rejection |
| `auto_close` | Task closed with auto-close enabled | Always pass |
| `supervisor` | Supervisor agent returns JSON with `"approved": true/false` | true = pass, false = fail |

> **👎 note:** A thumbs-down grade fires the retry logic immediately upon grading — the task does not need to be explicitly closed first. This lets a user reject a phase while the agent session is still active.

---

## Supervisor Step

When enabled on a phase, after the phase task receives a passing verdict the Planner automatically creates a verification task:

- **Subject:** `[Supervisor] Verify: {phase name}`
- **Agent:** planner's default harness agent
- **Auto-close:** yes — the agent's final message is parsed automatically when the task closes
- **Purpose:** verifies the phase output against its definition of done

**Expected response format:**
```json
{"approved": true, "explanation": "Phase output fully satisfies the requirements because ..."}
```
or
```json
{"approved": false, "explanation": "Phase output is missing X / incorrect because ..."}
```

The `explanation` field is required — it should describe the reasoning clearly.  
The parser is tolerant of prose wrapping the JSON — it extracts the first `{...}` block from the response.  
A malformed response (unparseable or missing `approved` key) is treated as `approved: false` → retry.

`approved: false` triggers the same retry logic as a 👎 inbox grade.

> **v1 note:** Supervisor check is not yet configurable in the UI — it defaults to disabled for all phases. The backend supports it; the UI toggle ships in v2.

---

## Retries

- Each phase has a `max_retries` setting (default: 3, inherits from planner)
- On each retry attempt:
  - Phase `retry_count` is incremented
  - All previous verdict/task data is cleared from the phase row
  - A new inbox task is dispatched
- When `retry_count >= max_retries`:
  - Phase status → `failed`
  - Planner status → `failed`
  - No further automatic action — the state is terminal

---

## API Reference

Base URL: `https://tasksquad-api.xajik0.workers.dev`  
Auth: `Authorization: Bearer <Firebase ID token>` on all requests.

### List planners

```
GET /teams/:teamId/planners
```

**Response**
```json
{
  "planners": [
    {
      "id": "01JXXXXXXXXXXXXXXXXXXXXXXX",
      "name": "Memory Feature",
      "status": "running",
      "current_phase_index": 1,
      "max_retries": 3,
      "auto_close": false,
      "paused": false,
      "default_sub_agent_id": null,
      "default_harness_agent_id": "01J...",
      "planner_verdict": null,
      "created_at": 1746900000000,
      "updated_at": 1746900000000
    }
  ]
}
```

---

### Get planner with phases

```
GET /teams/:teamId/planners/:plannerId
```

Returns the planner fields above plus a `phases` array ordered by `phase_index`:

```json
{
  "id": "...",
  "phases": [
    {
      "id": "...",
      "phase_index": 0,
      "name": "Product Research",
      "status": "completed",
      "task_id": "...",
      "retry_count": 0,
      "max_retries": 3,
      "auto_close": false,
      "user_verdict": "approved",
      "last_response": "Completed analysis...",
      "supervisor_task_id": "...",
      "supervisor_status": "completed",
      "supervisor_verdict": "yes",
      "created_at": 1746900000000,
      "updated_at": 1746900000000
    }
  ]
}
```

---

### Create planner

```
POST /teams/:teamId/planners
```

**Body**
```json
{
  "name": "Memory Feature",
  "description": "Optional",
  "max_retries": 3,
  "auto_close": false,
  "default_sub_agent_id": "01J...",
  "default_harness_agent_id": "01J...",
  "phases": [
    {
      "name": "Product Research",
      "sub_agent_id": "01J...",
      "harness_agent_id": "01J...",
      "auto_close": false,
      "max_retries": 3
    }
  ]
}
```

**Response** `201 Created`
```json
{
  "id": "01JXXXXXXXXXXXXXXXXXXXXXXX",
  "status": "running",
  "first_task_id": "01J..."
}
```

Side effects: inserts planner + all phase rows; dispatches Phase 0 inbox task immediately.

**Validation errors** (`400`)

| Code | Reason |
|---|---|
| `name_required` | `name` missing or blank |
| `phases_required` | `phases` array missing or empty |
| `invalid_max_retries` | `max_retries` outside 1–20 |
| `phase_name_required` | A phase has a blank name |

---

### Update planner (pause / resume / verdict)

```
PATCH /teams/:teamId/planners/:plannerId
```

**Body** (all fields optional)
```json
{
  "paused": true,
  "planner_verdict": 1
}
```

Setting `paused: false` on a paused planner triggers resume — if the current phase is already completed and approved, the next phase is dispatched immediately.

Set `planner_verdict: null` to clear it.

**Response** `200 OK`
```json
{ "ok": true }
```

---

### Delete planner

```
DELETE /teams/:teamId/planners/:plannerId
```

Deletes the planner and all phases via `ON DELETE CASCADE`. In-flight tasks are not cancelled.

**Response** `204 No Content`

---

## Data Model

### `planners`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | ULID |
| `team_id` | TEXT | FK → teams |
| `sender_id` | TEXT | FK → users — the user who created the planner |
| `name` | TEXT | |
| `description` | TEXT | Nullable |
| `status` | TEXT | `pending` \| `running` \| `completed` \| `failed` |
| `current_phase_index` | INTEGER | 0-based index of the active phase; -1 before first advance |
| `max_retries` | INTEGER | Default retry cap for all phases |
| `auto_close` | INTEGER | `0`/`1` boolean |
| `paused` | INTEGER | `0`/`1` boolean |
| `default_sub_agent_id` | TEXT | Nullable FK → sub_agents |
| `default_harness_agent_id` | TEXT | Nullable FK → agents |
| `planner_verdict` | INTEGER | `1` = approved, `0` = rejected, NULL |
| `created_at` | INTEGER | Unix ms |
| `updated_at` | INTEGER | Unix ms |

### `planner_phases`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | ULID |
| `planner_id` | TEXT | FK → planners (ON DELETE CASCADE) |
| `phase_index` | INTEGER | 0-based; `UNIQUE (planner_id, phase_index)` |
| `name` | TEXT | |
| `sub_agent_id` | TEXT | Nullable FK → sub_agents |
| `harness_agent_id` | TEXT | Nullable FK → agents |
| `status` | TEXT | `pending` \| `in_progress` \| `completed` \| `failed` \| `reverted` |
| `task_id` | TEXT | Nullable FK → tasks — current attempt's inbox task |
| `retry_count` | INTEGER | |
| `max_retries` | INTEGER | |
| `auto_close` | INTEGER | `0`/`1` boolean |
| `user_verdict` | TEXT | `approved` \| `rejected` \| NULL — mirrored from task grade |
| `last_response` | TEXT | Cached last agent message body — used as input to next phase |
| `supervisor_task_id` | TEXT | Nullable FK → tasks |
| `supervisor_status` | TEXT | `pending` \| `running` \| `completed` \| `failed` \| NULL |
| `supervisor_verdict` | TEXT | `yes` \| `no` \| NULL |
| `created_at` | INTEGER | Unix ms |
| `updated_at` | INTEGER | Unix ms |

### `tasks` additions

| Column | Type | Notes |
|---|---|---|
| `planner_phase_id` | TEXT | Nullable FK → planner_phases — set when task is created by the Planner |
| `planner_phase_role` | TEXT | `phase` \| `supervisor` — distinguishes main vs. supervisor task |

---

## Architecture

```
React Portal (Planners.tsx)
    │  GET/POST/PATCH /teams/:id/planners
    │  Polls GET /planners/:id every 5s while status = 'running'
    ▼
Cloudflare Worker (itty-router)
    │
    ├── /teams/:teamId/planners/*  ──▶  routes/planners.ts
    │                                        │
    ├── PATCH /tasks/:id/grade  (hook) ──────┤
    └── POST  /tasks/:id/close  (hook) ──────┤
                                             ▼
                                     PlannerEngine
                                   (planner/engine.ts)
                                         │
                              ┌──────────┼──────────────┐
                              ▼          ▼               ▼
                       TaskDispatcher  advance()      retry()
                    (planner/dispatcher.ts)
                              │
                              ▼
                    D1 batch() — atomic writes
                    planners + planner_phases + tasks
```

### Key design decisions

- **Atomic transitions** — every state change uses `D1.batch()` so a phase cannot be marked `completed` without the next task being recorded in the same atomic write.
- **Stateless engine** — `PlannerEngine` is instantiated per Worker request; no global state. Safe under Cloudflare's per-isolate execution model.
- **`VerdictSource` discriminated union** — adding a new signal source (CI result, webhook, custom approval) only requires a new variant. Existing engine code is unchanged.
- **Dispatcher interface** — `IPhaseDispatcher` is the seam between the engine and inbox. A future `WebhookDispatcher` can replace `TaskDispatcher` without touching the engine.
- **Supervisor template isolation** — `templates.ts` owns the prompt; it can be unit-tested independently and swapped per-planner in v2.

---

## Portal Component

**File:** `packages/portal/src/pages/Planners.tsx`

| State | Description |
|---|---|
| `planners` | List of planners from API; refreshed after create |
| `agents` / `subAgents` | Loaded on mount for dropdown population |
| `selectedId` | Which planner is in detail view; `null` = list view |
| `isLoading` | True while initial API fetch is in flight |
| Poll interval | 5 s while `selected.status === 'running'`; cleared on completion/failure |

Key behaviours:
- `handlePause` / `handlePlannerVerdict` call `api.planners.update` then update local state
- `handleCreate` calls `api.planners.create`, reloads the full list, then navigates into the new planner's detail view
- Phase cards with `task_id` are navigable via `useNavigate` to `/dashboard/tasks/:id`
- Phase `user_verdict` is **read-only** — it mirrors the inbox grade and cannot be set from the Planner UI

---

## Known Limitations (v1)

- Supervisor check toggle is not yet in the create form UI (backend ready, defaults to off)
- Failed planners are terminal — no manual retry from UI
- No push notification when a phase fails or planner completes
- Phase `max_retries` inherits from planner; no per-phase override in UI
- Deleting a planner does not cancel in-flight inbox tasks

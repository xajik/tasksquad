# Action Graph integration

The integration page of `action-graph-research-paper.html` supersedes the earlier
standalone Swift/SQLite architecture. Existing TaskSquad teams are projects.
The cloud accepts graph transitions; inbox agents only propose them.

## Contracts

- Unpublished proposals are separate from active/deactivated published nodes.
- Every assignment snapshots configuration, input, prompt and schema versions.
- Only the expected agent/session/attempt can supply its result. Notify and close
  share durable intake; a task's done status is never graph approval.
- Review approves an exact immutable output. Duplicate delivery is idempotent.
- Parse whole JSON, allowing one enclosing JSON fence. Formatting repair is a
  separate read-only assignment and never repeats external actions.
- D1 is authoritative. Decisions and outbox writes commit atomically; R2 and
  vector indexes are derived. Regrades replace credit rather than maximize it.
- Goals require owner-approved sufficient predicates with fresh evidence.
- Execution requires baseline, scoped restoration predicates, undo and recovery
  budget. Stale-result rejection cannot stop external effects: reconcile before
  replacement execution.
- Local agents are trusted with machine access. Role sessions and supplied
  context are isolated; this is not a filesystem sandbox or secrecy guarantee.

## Delivery checkpoints

1. Create/decompose: persistence, contracts, coordinator, inbox intake, exact
   review, web creation and subgoal display.
2. Reversible cycle: role isolation, planning/merge, single execution, FIFO
   grading/projection, evidence and compensation.
3. Concurrent recovery: capacity/reservations, retries, reconciliation, four
   independent maintenance jobs and daily ledger.
4. Complete workspace: R2/vector outbox, scoped search, graph canvas/inspector,
   activity/reviews/exports and replay acceptance tests.

New functionality defaults off. Apply additive D1 migrations before deploying
dependent Worker code. Do not enable execution on incompatible daemons. Pausing
new dispatch must preserve result intake and recovery.

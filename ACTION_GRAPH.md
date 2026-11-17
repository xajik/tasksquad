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

## Implemented runtime

The web Graph workspace uses ordinary inbox tasks for decomposition, backward
and forward merge review, planning, execution, grading, private projection,
continuation, reconciliation and compensation. Unpublished proposals remain
visible while independent review runs. Milestone retirement appends a state
record. Equivalent action contracts reuse published work rather than dispatching
another copy.

One project coordinator serializes commands. D1 version claims and unique run
claims protect database writes across retries/restarts. A single durable serial
queue orders completed executions, regrades, continuation decisions and periodic
private decomposition reviews. A review gate at its head holds later work,
including work assigned to a fallback agent. Formatting repairs inherit their
original role's queue and agent selection.

Execution capacity and agent reservations are separate from the grading queue.
The heap is rebuilt from durable assignments; scores combine local quality,
private alignment, uncertainty, freshness and a recovery allowance. Every fifth
normal allocation tries the eligible lower-ranked tail. This is a bounded
heuristic, not a calibrated probability of success. Evidence is credited once
per executed lineage; revised grades replace contributions without adding visits.

Structured blocked results free execution capacity. Timeout/restart recovery
holds the affected reservation, requests cancellation through the existing task
state protocol, and requires an authenticated idle heartbeat acknowledging the
old task before replacement execution or compensation. Reconciliation must also
verify restoration predicates. It cannot fence an arbitrary external system;
local agents and their observations remain trusted.

Daily views derive completed attempts and every node's state from normalized
source records. Goal truth is independently computed from the owner's sufficient
rule and fresh scoped evidence, including conflicts. A score or connected route
cannot establish success.

## Local verification

For real daemon polling and provider lifecycle with real Claude model calls:

```bash
make -C packages/worker graph-local-daemon
```

This builds a headless development entry point around the shipping Go daemon's
heartbeat, assignment handling, process spawning, terminal relay and session
callbacks. Its `stdout` provider runs a restricted Claude adapter. It uses
`TSQ_STATE_DIR` for local logs, task journals, device ID and hook capabilities,
and process-local credential storage; it never changes the login Keychain,
autostart or the installed daemon. The normal approximately 60-second polling
interval applies. The hook server uses port 17374. R2 presigned log uploads need
cloud credentials and are not configured here; full logs remain in
`.runtime/action-graph-local/daemon-state/`. This mode does not test interactive
tmux providers or the desktop daemon UI.

Start the real Worker and portal with an isolated local database and CLI agents:

```bash
make -C packages/worker graph-local
```

Open `http://127.0.0.1:5180`. The command prints a direct link to the seeded
**Local reversible file test** graph. It starts in Draft: click **Run**, then
approve the results shown under **Needs attention** as they arrive. The installed,
authenticated Claude CLI runs each role in a fresh session. Model calls begin
only after Run. The sample changes `.runtime/action-graph-local/sandbox/verification.txt`
from `TaskSquad local graph baseline` to `TaskSquad local graph works`, then
independently reads the file to establish the goal predicate. Its restoration
contract restores the original text.

This needs Bun, Node, Python 3 and an authenticated `claude` CLI. The local CLI
runner exposes file tools within the sample sandbox and does not expose shell
tools. It exercises real inbox assignments, session callbacks, review and graph
coordination; it does not test the installed daemon's polling or tmux integration.
For the same sample without model calls, use:

```bash
make -C packages/worker graph-local GRAPH_AGENTS=deterministic
```

The API listens on `127.0.0.1:8788`. A seeded local CLI token uses the standard
API authentication path; the portal accepts it only in development on loopback
with a loopback API. No Firebase setup is needed. D1, R2, KV and coordinator
state persist under ignored `.runtime/action-graph-local/`; production resources
and installed daemon settings are untouched. Keep the terminal running and use
Ctrl+C to stop its services. Restarting preserves graphs and review progress.

Use package Make targets:

```bash
make -C packages/worker check
make -C packages/worker test
make -C packages/worker build
make -C packages/portal test
make -C packages/portal build
make -C packages/daemon test
make -C packages/macos test-compatibility
```

The Worker suite applies the entire SQL migration chain to local D1 and exercises
real coordinator RPC, runtime reload, alarm replay, duplicate notify/close intake,
exact-result approval, downward regrading, serial continuation, compensation and
late-result fencing. It does not invoke production models or perform production
side effects. The portal tests the local authentication guard; its build
checks TypeScript and the PWA bundle. With `make -C packages/portal dev`, open
`/scripts/graph-preview.html` for a synthetic interactive workspace, or append
`?readOnly` for member controls. This fixture is not a production build entry.

## Rollout (not performed by implementation)

1. Apply migrations `0051` through `0059` with the existing Worker migration Make
   target before deploying this Worker. The coordinator adds Durable Object
   migration `v5`. Preserve existing migrations, WebSocket guards and bindings.
2. Deploy with `ACTION_GRAPH_ENABLED="false"`, then release/install compatible
   Go or Swift daemons. They advertise `graph_isolation_version=1`; execution and
   undo are withheld from daemons that lack recent capability heartbeats.
3. Enable `ACTION_GRAPH_ENABLED="true"` for cloud dispatch and
   `VITE_ACTION_GRAPH_ENABLED="true"` for the portal navigation. Start with one
   execution slot, explicit review and a separate execution/grading agent. Prove
   the decomposition round trip before allowing reversible execution.
4. Provision optional Workers AI and Vectorize bindings to enable semantic
   retrieval. Without them, scoped structured search remains available and index
   outbox entries stay pending. Use a 768-dimensional cosine index for
   `@cf/baai/bge-base-en-v1.5`, and create metadata indexes for `graph_id` (string),
   `version` (number) and `visibility` (string) before indexing. References:
   [model contract](https://developers.cloudflare.com/workers-ai/models/bge-base-en-v1.5/)
   and [metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/).

Example optional bindings after provisioning:

```toml
[ai]
binding = "GRAPH_AI"

[[vectorize]]
binding = "GRAPH_VECTORS"
index_name = "tasksquad-graphs"
```

Embeddings are derived, UTF-8 bounded chunks with a reusable R2 cache. Index jobs
persist a cursor and process bounded batches; current-version semantic retrieval
may lag graph updates, with structured search available throughout. Settings →
Rebuild search index creates a fresh outbox generation. When changing the model,
provision a matching index and update both ingestion and query model references;
never mix incompatible embedding spaces.

R2 artifacts use `graphs/<team>/<graph>/...` prefixes. Graph APIs authenticate
project membership; mutations require owner/maintainer access. Private role
outputs bypass ordinary task-completion learning hooks. Role session separation
and filtered supplied context do not restrict a trusted CLI's machine access.
Native macOS/iOS Graph interfaces are intentionally deferred.

To halt new normal work, set `ACTION_GRAPH_ENABLED="false"` or pause a graph.
Existing result intake, review, grading and required recovery remain available.
Stop cancels unstarted ordinary work and starts reconciliation for active
execution; it does not silently undo previously successful actions. Keep the
compatible Worker/migrations available while outstanding work is reconciled.

Monitor structured `graph_wake_failed`, `graph_result_wake_failed`,
`graph_search_fallback` events; inspect invalid/review results, FIFO backlog,
retained reservations and `graph_outbox.error/attempts/cursor`. All graph events
and source results remain available through the snapshot/export API.

# Graph watch: "Nasty Bottle: first 100"

Graph 01M7QMRRYJJDD0B2FC011HE5AV. Goal (from list): "Create viral product and sell first 1000 bottles". Status: running.

## 2026-11-19 01:38 — run 1

- Graph list shows it as `running`. Inbox is full of `[Graph 01M7QMRRYJJDD0B2FC011HE5AV] repair / merge / project` tasks, all `done`, so agents are working.
- Could NOT read the graph detail page: it renders a blank white screen (no nodes, no text).
  - Console: `Error: Unable to route graph edge around obstacles` (uncaught, thrown in a `useMemo` render).
  - Source: `packages/portal/src/lib/graphLayout.ts:145`. The A* edge router exhausts its grid with no path and throws, and nothing catches it, so React unmounts the whole page.
- The tsq CLI has no graph command, so no non-UI way to inspect it. I didn't dig into the API.
- Nothing to unblock this run (tasks done, no blocked state visible).

### Improvements
1. **Portal (high):** don't let one unroutable edge blank the page. Catch the error in `graphLayout.ts`, fall back to a straight or simple elbow line for that edge, and add an error boundary around the graph canvas.
2. **Portal:** on a large graph with many repair/merge nodes, check why the router has no path (obstacles too dense or endpoint inside a box). Add a test with this graph's shape.
3. **Ops:** a graph-status view or API/MCP tool for progress (nodes done / bottles sold) would let this watch run without the canvas.

Next: re-check; the canvas will keep failing until fixed (not deploying, per instructions).

## 2026-11-19 ~03:10 — run 2

- Graph page still blank (same routing error), so no node view.
- Inbox shows only `done` graph tasks (decompose → plan → merge/repair → project) across agents `cc-nasty` and `cdx-nasty`. The newest is ~2h old, and nothing is pending or in progress. The graph says `running` but has produced no task for ~2h, so it may be stalled or waiting on something I can't see.
- Couldn't unblock: no node/state visibility without the canvas and no CLI graph command.

### Improvements (added)
4. Graph status should surface "no active node for N min" and the reason (waiting on human, acceptance failing, scheduler idle).
5. Verify why `running` graph stopped spawning tasks once the canvas bug is fixed (needs the graph/runs API, not just the inbox).

## 2026-11-19 ~04:40 — run 3

- Graph page still blank. Inbox unchanged: same 22 `done` tasks, newest now ~4h old. No new tasks since run 2, so the graph has been idle ~4h while showing `running`. Likely stalled, but I can't confirm the reason or unblock without graph state.
- Recommend: fix the canvas (improvement 1) or give me a graph API/MCP route; otherwise further runs add no information.

## 2026-11-19 ~06:10 — run 4

- No change: canvas still blank; same 22 `done` tasks, newest ~5h old. Graph idle ~5h while `running`. Nothing unblockable from here.

## 2026-11-19 ~07:40 — run 5

- No change: canvas blank; same 22 `done` tasks, newest ~7h old. Idle ~7h while `running`. Nothing unblockable from here.

## 2026-11-19 ~08:30 — manual check after canvas fix (f5618c6)

- Canvas renders now. Graph: 0 active jobs, 23/100 attempts, 3 blocked/recovering, 6 "Needs you" error tasks (merge/repair/project), pending execute/project tasks held behind them ("review at the head holds later grades").
- **Root cause of the 7h idle:** merge-review tasks (e.g. inbox task 01M7QMXJDYXS3YRY3QJECRFSGR, agent cc-nasty) were delivered to the agent truncated. The agent replied "Your message looks cut off. All I received was the end of a JSON snippet: `ia for the brand.","parent_id":null}]}`". The review prompt is a long single-line JSON blob (~5KB with the full hierarchy body). It never produced the required JSON, so the merge review was rejected, then repair attempts failed the same way, and the graph is waiting on a human reply.
- Two proposals blocked: "Verify production measurement, privacy, search discovery, and operating alerts" and "Establish the Production evidence baseline and a gated customer acquisition and fulfillment plan".

### Improvements (added)
6. **Daemon/tmux delivery (high):** long graph prompts get cut off when sent to the agent (probably tmux send-keys/paste buffer of a large single line). Send via a file or `load-buffer`/`paste-buffer`, or pass a path in the prompt. Test with a >5KB single-line prompt.
7. **Graph:** a merge task whose agent returns non-JSON should auto-retry once without human help, and the failure reason should show on the graph ("agent said: message cut off").
8. **Graph:** "Needs you" should say why in the card, not only "error".

## 2026-11-19 08:55 — tick 1 (in charge)

- Shipped: worker YAML/capped prompts (43cdc01, deployed), Go daemon paste fix (tag v0.3.23, released), role identities from Skills `tsq-graph-<role>` (ab003a1).
- **Found:** the daemon on this machine is the Swift `TaskSquad Native.app` (tsq-core), not the Go `tsq` (~/.local/bin/tsq is stale v0.3.4). The Go fix alone would not have reached the agents. Ported the same paste-vs-type rule to `TmuxTaskSession.sendText` (long or multi-line → tmux paste-buffer), pushed, rebuilt with `make install` and relaunched the app (no tmux sessions were running).
- Replied in the inbox thread of blocked merge task 01M7QMXJDYXS3YRY3QJECRFSGR; reply accepted ("continuation checking the checkpoint; follow-up appears as a new inbox task"). Other blocked tasks to follow next tick once this one proves the path.

### Improvements
9. Keep Go and Swift daemons' tmux delivery in one spec/test (a shared golden test: 5KB multi-line prompt arrives intact).
10. Stale `~/.local/bin/tsq` v0.3.4 shadows the app's CLI; `make install-cli` should refresh it or warn.

## 2026-11-19 ~09:25 — tick 2

- First reply worked: proposal "Verify production measurement…" went from `blocked` to `pending` (blocked/recovering 3→2). New dispatch not yet seen in daemon log (agents poll every 60s; nothing pending at 09:20).
- Replied to the blocked merge task 01M7QNBC2TEKJH1DXBVDE6JRXE and project task 01M7QR79QETFH1W03MTZNS963M (same truncation, same retry message); both accepted. Remaining "Needs you" rows are 3× `repair`, which cannot take replies (can_reply is false for role=repair).
- Still open: "Establish the Production evidence baseline…" proposal blocked; will reply next tick if still blocked.

### Improvements
11. Repair tasks show "Needs you" but cannot be replied to; either allow reply or auto-retire them when the parent step is retried.
12. A reply only says "continuation checking the checkpoint"; show when the follow-up task is expected.

## 2026-11-19 ~10:10 — tick 3

- Retries ran (attempts 23→25) but the agent still got only a fragment. Proof: the Claude transcript of the 09:21 session has a 630-char first user message — the tail of the ~5KB YAML prompt. **Real root cause:** `tmux paste-buffer` without `-p` converts every LF to Enter, so each YAML line was submitted as its own message. (The earlier JSON failure was the same tail-only symptom.) Stored prompts are intact: YAML, capped, schema complete.
- Fix: `paste-buffer -p` (bracketed paste) in tsq-core `pasteText` and Go `PastePromptFile`; pushed, app rebuilt/relaunched, no tmux sessions active. Replied on blocked `continue` task 01M7RP8PG0W3R35H5DY7NAE2DT to re-dispatch. Verify next tick: a new task's first user message in ~/.claude/projects/-Users-igorsteblii-Projects-nasty-bottle/*.jsonl should be the full length.
- State: blocked/recovering 1 (+3 repair errors that cannot be replied to), both proposals back to `pending`.

### Improvements
13. Add a daemon test that pastes a multi-line prompt into a real tmux pane running a bracketed-paste-aware program and asserts one line-preserving submission.
14. Daemon should log the delivered prompt length/hash so truncation is visible without opening Claude transcripts.

## 2026-11-19 ~10:35 — tick 4

- **Delivery fixed and verified:** the 09:52 session's first user message was the full 5619 chars (pasted, intact). Agent returned valid JSON.
- New problem: the `continue` agent answered `blocked` ("context truncated, no checkpoint"). Continue was designed for side-effecting steps; for read-only steps (merge/project/grade/…) only `execute`/`undo` are `actionable` in the engine, so `restart` needs no verification. Fix 7117d3e (deployed): `original_role` added to continue input; continue instruction says read-only roles with invalid prior results → `restart`; `[truncated N chars]` markers explained as size-only.
- Replied on blocked continue task 01M7RP8PG0W3R35H5DY7NAE2DT to retry. Check next tick that a restarted project step ran (attempts 26 → higher, blocked/recovering 0).

### Improvements
15. A failed read-only step (invalid result from delivery/format) should auto-restart without any human reply; reserve "Needs you" for real blockers.
16. Continue prompts carry the whole previous input again (nested); drop `previous` and send only ids + original_role to keep them small.

## 2026-11-19 ~10:45 — tick 5: runaway loop

- **Incident:** attempts 26→53/100 in ~30 min; a new `continue` task every minute (cc-nasty, all `done`). Cause: my reply on a blocked *continue* assignment created continue(parent=continue); on `restart` the engine re-created the parent's role (continue) again → endless chain. Not caused by delivery or YAML; caused by replying on a continue.
- Tried to pause the graph via the portal; the action was denied by the permission classifier, so I did not work around it. Fix instead: engine now walks up to the first non-continue ancestor (commit pushed; worker deploying). The chain should end on the next restart with a real `project` step.
- Needs user: if the loop is still creating continues after deploy, press Pause on the graph page; budget left ~47 attempts.

### Improvements
17. Guard against self-chaining: reject `input` on an assignment whose role is `continue` (or cap continue depth), and alert when >5 same-role attempts occur in 10 minutes.
18. The Pause button should be reachable by the watcher (API/MCP tool) for incident response.

## 2026-11-19 ~11:25 — tick 6

- Loop ended 11:04 after the continue-chain fix deployed, but it had already burned attempts: **71/100**. The loop left a pile of duplicate `project` tasks; all answered with valid results. Pipeline now works end to end: project result valid → decomposition feedback → new decompose/merge proposals pending (0 blocked, 0 awaiting review).
- Idle since 11:06 with ~14 pending decompose/merge nodes and 0 active jobs. Suspect dispatch waits on a wake/serial gate; check next tick, and if still idle >30 min read `engine.ts` dispatch (role isolation / serial queue / the 4 stale repair errors "Needs you").
- Quality issue: the 6000-char cap truncated hierarchy bodies; the project agent said so and scored 0. Raised to 16000 (commit 59831fa), since paste delivery handles it.
- Budget: 29 attempts left; loop damage is the main risk to the experiment.

### Improvements
19. Attempt budget should not be consumed by retries of the same assignment caused by infra faults (delivery/parsing); count only meaningful attempts.
20. Serial queue: dedupe `project`/`grade` steps for the same work id so one reply cannot create dozens.

## 2026-11-19 ~12:00 — tick 7: STALLED on planning budget

- Idle since 11:06. Read-only production check (wrangler d1, no writes): 12 `decompose`/`merge` assignments are pending and available, agents idle, serial queue empty, no reservations, graph `running`, attempts 71/100.
- **Cause:** `dispatch` (engine.ts ~1541) refuses decompose/plan/merge once `planning_budget` attempts are reached. Policy `planning_budget` = 20 and the graph has used exactly 20 (3 decompose + 4 plan + 13 merge) — mostly merge attempts burned by the delivery bug overnight. Nothing can be dispatched for planning, so the graph is silently stuck.
- Fix needs a config change (graph Settings → planning budget; the engine requires Pause before `configure`) or a DB edit. Pause click was denied by the permission classifier earlier, and a direct production DB write is the user's call. Not done; asked the user.
- Also: 12 duplicate pending decompose/merge rows from the continue-loop will all run once the budget is raised (≈12 more planning attempts); consider cancelling duplicates first.

### Improvements
21. Show "planning budget exhausted (20/20)" on the graph page instead of silent idleness; alert the owner.
22. Do not count attempts whose result was `invalid` from infra faults against planning/attempt budgets.
23. Cancel duplicate pending decompose/merge assignments for the same proposal when the loop is fixed.

## 2026-11-19 12:20 — tick 8

- Unchanged: still stalled on planning budget 20/20 (read-only D1 check). 12 pending decompose/merge, 2 pending execute, attempts 71. No daemon task since 11:06 (~75 min idle). Waiting on the owner to pause the graph and raise `planning_budget` in Settings (or approve a direct change). No other safe action available.

## 2026-11-19 12:50 — tick 9

- Unchanged: graph `running`, `planning_budget` still 20 (exhausted), no daemon task since 11:06 (~105 min idle). Waiting on owner decision to raise it. No action taken.

## 2026-11-19 13:20 — tick 10
- Unchanged: stalled on planning budget (20/20), no daemon task since 11:06 (~2h15 idle). Still awaiting owner decision; no action.

## 2026-11-19 13:50 — tick 11
- Unchanged: stalled on planning budget (20/20); no daemon task since 11:06 (~2h45 idle). Awaiting owner decision; no action.

## 2026-11-19 14:20 — tick 12
- Unchanged: stalled on planning budget (20/20); no daemon task since 11:06 (~3h15 idle). Awaiting owner decision; no action.

## 2026-11-19 14:50 — tick 13
- Unchanged: stalled on planning budget (20/20); no daemon task since 11:06 (~3h45 idle). Awaiting owner decision; no action.

## 2026-11-19 15:20 — tick 14
- Unchanged: stalled on planning budget (20/20); no daemon task since 11:06 (~4h15 idle). Awaiting owner decision; no action.

## 2026-11-19 15:50 — tick 15
- Unchanged: stalled on planning budget (20/20); no daemon task since 11:06 (~4h45 idle). Awaiting owner decision; no action.

## 2026-11-19 16:20 — tick 16
- Unchanged: stalled on planning budget (20/20); no daemon task since 11:06 (~5h15 idle). Awaiting owner decision; no action. Watch ends ~16:45.

## 2026-11-19 16:50 — final summary (watch ended, cron deleted)

**State:** graph `running` but stalled since 11:06 (~5h45): `planning_budget` 20/20 used, 12 decompose/merge + 2 execute pending, attempts 71/100, 4 old repair errors still "Needs you" (not replyable).

**Fixed and shipped today**
1. Canvas white screen: graphLayout edge routing falls back to an elbow instead of throwing (f5618c6).
2. Prompts: compact YAML, size cap (now 16000) (43cdc01, 59831fa).
3. Delivery: root cause was tmux `paste-buffer` without `-p` turning newlines into Enter, so agents saw only the tail; long/multi-line prompts now pasted with bracketed paste in Go (v0.3.23) and Swift tsq-core, app rebuilt and relaunched locally.
4. Role identities from Skills `tsq-graph-<role>` (ab003a1).
5. Continue prompt: read-only steps restart, not blocked (7117d3e). Continue-of-continue loop fixed (43a6f2b).

**Open (needs owner)**
- Raise `planning_budget` (20 → ~40) via graph Pause + Settings, then let the 12 pending planning steps run (cancel duplicates first if possible). Without it the graph does nothing.
- Create `tsq-graph-*` skills on the Skills page if custom identities are wanted.
- Stale `~/.local/bin/tsq` (v0.3.4) should be refreshed.

**Top improvements**
- Show "planning budget exhausted" and alert; don't count infra-invalid attempts against budgets.
- Auto-restart failed read-only steps; guard against continue chaining; dedupe project/grade steps.
- Watcher API/MCP tool for pause/configure; daemon test for multi-line paste; log delivered prompt length.

## 2026-11-19 ~22:00 — redeploy and resume

- Verified deployed: worker at 336c839 (Deploy Worker success), Go daemon tagged v0.3.24 (includes `paste-buffer -p`), app reinstalled from main and relaunched (tsq 0.4.12; no tmux sessions were running).
- Resume: Settings refused the revision because `configure` required zero open assignments. Fixed in engine (336c839): budget-only changes are allowed with pending work. Paused graph, set planning budget 20→40 and total attempts 100→150, saved (page shows 71/150), ran graph.
- Result: graph `running`; decompose and merge running; planning 22/40, attempts 73/150; 10 more pending. Watch for the 9 stale duplicate decompose rows from the earlier loop — they will each burn an attempt.
- Re-armed the 30-minute watch (:07/:37).

## 2026-11-19 22:20 — tick 17 (after resume)

- Resume worked mechanically: 12 planning tasks ran 21:57–22:08 (attempts 73→83, planning 32/40), delivery and parsing healthy (results valid JSON). All 12 ended `stale` → assignments `blocked` ("Needs you"): they were duplicates created during the earlier continue-loop, so the hierarchy moved on before their results arrived. I did not reply to them (each reply = a continue + restart = more attempts for results that go stale again).
- No runaway loop: tasks stopped at 22:08, 0 active jobs.
- **Real blocker (owner decision):** the 2 pending `execute` nodes can never dispatch: plan cost 500 and 20,000 (recovery 100 / 2,000) exceed the graph's `cost_budget` 100 and `recovery_budget` 25 (dispatch skips execute when budget would be exceeded, engine.ts ~1533). These are the real spend authority numbers for interviews and compliance testing; raising them is a financial decision, so not done.
- Still open: 4 old repair errors; 12 stale blocked duplicates (noise).

### Improvements
24. Reject/cancel duplicate pending assignments at creation (same proposal, same context hash).
25. Show "execution skipped: plan cost 500 > budget 100" on the node; right now execute rows sit "pending" for 20h with no reason.
26. Stale results should resolve to `cancelled`, not `blocked`/"Needs you".

## 2026-11-19 22:42 — owner requests (YAML replies, reply only while session open, 100x limits)

1. **YAML replies:** agents are now told to answer with one YAML document (values double-quoted, block lists). `parseResult` uses the `yaml` package (core schema, no aliases); JSON replies and ```yaml/```json fences still parse (YAML is a superset); prose still rejected by schema validation. Prompt says so in the instruction line.
2. **Reply only while the session is open:** `graphInboxTask.can_reply` now also requires the inbox task not be `done`/`failed`/`cancelled` (so finished and stale graph tasks no longer show a reply box, and the API rejects replies). Test updated; added a done-task assertion.
3. **Limits ×100:** attempts 150→10000, planning 40→2000, cost 100→10000, recovery 25→2500 (saved via Settings; graph paused then run). Note: the 20,000-cost execute plan still exceeds 10,000 and will stay pending; the 500-cost interview plan can now run.
- Shipped: b28efdf (worker deployed, success), tests 292 pass.

### Improvements
27. Because replies now require an open session, stale/blocked graph steps with finished sessions cannot be continued from the inbox: add a graph-level "retry/cancel step" action.
28. With 10000-attempt budgets a loop is no longer bounded by budget: add a rate limiter (e.g. max N dispatches per role per 10 min).

## 2026-11-19 22:55 — sub-agent identities published

- Created on the Skills & Sub-agents page (auto-install on): `tsq-graph-grader` (read-only tools; judges evidence, YAML reply, different agent from executor) and `tsq-graph-executor` (one approved plan step; stays in scope/cost/undo; verifies checkpoint before resuming; blocked without approval).
- Local install verified: after an app relaunch (sync is hourly + at start) the daemon logged `Installed sub-agent ... v1 → ~/Projects/nasty-bottle` and the files exist in `.claude/agents`, `.agents/agents`, `.agent/agents` there. Not installed in tasksquad-doc (no graph agent works there).
- Ran both via `claude --agent <name> -p` from nasty-bottle: grader returned YAML score 0 for empty evidence; executor returned `blocked` for a 20000 spend over a 10000 limit with no approval.
- Not wired into the graph dispatch yet: the worker's role-identity lookup uses Skills named `tsq-graph-<role>` (not sub-agents). Improvement 29: have dispatch tell the CLI which sub-agent to use (e.g. prefix the task with "use sub-agent tsq-graph-grader") or create matching skills.

## 2026-11-19 22:50 — tick 18: first execution ran, blocked on owner approvals

- No loop (last task 22:42), attempts 86, cost 500 reserved. The buyer-interviews `execute` ran (22:42) with the new executor flow and returned a well-formed result `outcome: blocked`: it produced candidate market/segment pairs (US gym users, UK desk workers, Singapore commuters), a draft neutral interview script and willingness-to-pay questionnaire, and made **no outreach, spending or messages**. It needs owner approval for: the interview script, a numeric price ladder and currency, recruiting channels, a numeric interview limit, an approved project-record destination, access to participants via the live site/support contact, and a spec for what "sensing" measures.
- The result is stored `stale` and the step is `blocked`; its session is done, so (per the new "reply only while session open" rule) the inbox no longer offers a reply. The owner approvals therefore have no inbox path right now. Needs an owner decision: either supply the approvals in the graph's resources/goal text, or allow replies on blocked graph steps again.
- Remaining: 1 execute pending (20,000 cost > 10,000 limit), 10 stale decompose + 3 stale merge blocked (noise), 4 old repair errors.

### Improvements
30. A blocked executor result should create a first-class "approval needed" item listing the missing approvals, answerable even after the session closed (conflicts with rule 2; needs a distinct path from stale-duplicate noise).
31. Let owners attach approvals as graph resources/policy fields (price ladder, interview limit, recording destination) instead of replying in a thread.

## 2026-11-19 23:15 — graph page UI (collapsible, node click, report, latest message) + bump

- Node clicks: root cause was pointer capture. A card press captured the pointer on the svg, so the browser sent the click to the svg and the card's onClick never ran. Fixed by selecting on pointer-up when the card was not dragged (GraphCanvas). Verified live with a real pointer click: card highlights and the inspector fills.
- New `GraphSection` (collapsible, state remembered in localStorage, (i) help with two examples) used for: Goal description, Latest message, Daily report, Proposals, Action graph and inspector, Work queue. Help text in `graphHelp.ts`.
- Latest message sits under the title/status line: newest agent result in plain words + role/status/time + inbox link (JSON or YAML reply summarised via `summarize`).
- Daily report is now a readable section on the page (headline, finished by role, results accepted/invalid, what needs you, nodes changed, budget), raw per-attempt list under Details; the old report tab was removed. `lib/graphReport.ts` + test.
- Bump: `make bump` failed because tags v0.3.23/v0.3.24 had been created by hand while Makefile still said 0.3.22; set daemon VERSION to 0.3.24 then bumped. Now daemon 0.3.25 (tag v0.3.25 pushed → GoReleaser), macos 0.4.13, ios 0.1.13 (build 14), worker 0.0.13, portal 0.0.13, mcp 0.0.12. Portal deploy 5832964 succeeded.

### Improvements
32. Releases I cut by hand (v0.3.23, v0.3.24) should go through `make bump` so Makefile and tags never drift.
33. Daily report uses local midnight; for a graph running across midnight show "last 24 hours" as an option.

## 2026-11-19 23:20 — overnight watch re-armed (30 min, until ~07:20)

## 2026-11-19 23:30 — night tick 1
- Unchanged: graph `running`, attempts 86, cost 500, no new task since 22:42 (48 min), no loop. Waiting on owner approvals for the blocked buyer-interviews execute; compliance execute (20000) over the 10000 limit. Nothing actionable without the owner.

## 2026-11-20 00:00 — night tick 2
- Unchanged: `running`, attempts 86, last task 22:42 (~1h20 idle), no loop. Still waiting on owner approvals; no action.

## 2026-11-20 00:30 — night tick 3
- Unchanged: `running`, attempts 86, last task 22:42 (~1h50 idle), no loop. Awaiting owner approvals; no action.

## 2026-11-20 01:00 — night tick 4
- Unchanged (see query above): no new tasks, no loop; awaiting owner approvals.

## 2026-11-20 01:30 — night tick 5
- Unchanged (query above): no new tasks, no loop; awaiting owner approvals.

## 2026-11-20 02:00 — night tick 6
- Unchanged (query above): no new tasks, no loop; awaiting owner approvals.

## 2026-11-20 02:30 — night tick 7
- Unchanged (query above): no new tasks, no loop; awaiting owner approvals.

## 2026-11-20 03:00 — night tick 8
- Unchanged (query above): no new tasks, no loop; awaiting owner approvals.

## 2026-11-20 03:30 — night tick 9
- Unchanged (query above): no new tasks, no loop; awaiting owner approvals.

## 2026-11-20 04:00 — night tick 10
- Unchanged (query above): no new tasks, no loop; awaiting owner approvals.

## 2026-11-20 04:30 — night tick 11
- Unchanged (query above): no new tasks, no loop; awaiting owner approvals.

## 2026-11-20 05:00 — night tick 12
- Unchanged (query above): no new tasks, no loop; awaiting owner approvals.

## 2026-11-20 05:30 — night tick 13
- Unchanged (query above): no new tasks, no loop; awaiting owner approvals.

## 2026-11-20 06:00 — night tick 14
- Unchanged (query above): no new tasks, no loop; awaiting owner approvals.

## 2026-11-20 06:30 — night tick 15
- Unchanged (query above): no new tasks, no loop; awaiting owner approvals.

## 2026-11-20 07:00 — night tick 16
- Unchanged (query above): no new tasks, no loop; awaiting owner approvals.

## 2026-11-20 07:30 — overnight watch ended (cron deleted)

- 16 ticks (23:30–07:30): graph `running`, attempts 86 / 10000, cost 500 / 10000, no new task since 22:42 (~8h45), no loop, no errors.
- Stalled, by design, on owner input: buyer-interviews `execute` returned `blocked` and needs approvals (interview script, numeric price ladder + currency, recruiting channels, interview limit, record destination, participant access, "sensing" spec). The compliance `execute` (cost 20,000) exceeds the 10,000 cost limit.
- Noise still present: ~13 stale blocked duplicate steps, 4 old repair errors.
- Decisions needed from the owner: (a) provide the approvals (via graph goal/resources, or re-allow replies on blocked steps), (b) raise cost limit above 20,000 or shrink that step, (c) wire sub-agents tsq-graph-grader/executor into dispatch, (d) cancel stale duplicates.

## 2026-11-20 08:45 — owner decisions applied

- (2) Cost limits 10x: execution cost 10000→100000, recovery 2500→25000 (paused, saved, ran). Saved config verified in D1 (100000/25000).
- (4) Dismissed duplicates: new `dismiss` command + "Dismiss out-of-date steps" button (Work queue). It cancels blocked/error steps whose result went stale plus repair errors; never execute/undo/reconcile. Result: 17 cancelled (10 decompose, 3 merge, 4 repair); blocked/recovering 14→1 (the buyer-interviews execute, kept on purpose). Commit 715c10b, worker+portal deployed.
- After run: graph `running`, 9 `project` steps pending (serial queue, none dispatched yet, attempts still 86), no loop. The compliance execute is now `expired` (candidate TTL 24h); needs a re-plan.
- (1) Approvals via the Graph UI: owner to add a resource with the approval values; note a blocked execute with a closed session cannot be continued, so a "Retry step" action or a re-plan is needed afterwards (improvement 34).
- (3) Explained sub-agent wiring options in chat.

### Improvements
34. "Retry step" for blocked/expired execute steps so approvals can be applied without replying in a closed session.
35. Warn when a candidate expires (24h TTL) while it is waiting on owner input.

## 2026-11-20 10:45 — sub-agents wired into dispatch (B with fallback)

- **B:** daemon starts Claude Code as `claude --agent tsq-graph-grader` (grade, project, reconcile) or `--agent tsq-graph-executor` (execute, undo, continue) when the sub-agent file exists in `<workDir>/.claude/agents`; merge/decompose/plan/repair run as the plain CLI. Go (`agent/graph_agent.go`) and Swift (`DaemonEngine.graphAgentArguments`); tests in both. The role comes from `task.graph.role` that the worker already sends.
- **Fallback:** for any other CLI, or when the sub-agent file is not installed, the identity body (frontmatter stripped, 1600 chars max) is read from whichever harness dir the sync wrote (.claude/.agents/.agent/.gemini/.pi/.forge) and prepended to the prompt as "Identity:". The worker-side `tsq-graph-<role>` skills override remains available as a replace-the-instruction option.
- Released: tag v0.3.26 (daemon), macos 0.4.14, ios 0.1.14, worker/portal 0.0.14, mcp 0.0.13. Local app reinstalled (tsq 0.4.14) and relaunched.
- **Found a deadlock:** since 22:42 the strict serial queue's head was the stale result of the blocked buyer-interviews execute (seq 15), so no project/grade could dispatch (11 duplicate project reviews piled up, attempts frozen at 86). `dismiss` now also marks stale/invalid/rejected execution entries and cancelled assignments' entries done. Pressed Dismiss; head moved to seq 16 and a project task dispatched at 10:44.
- To verify next: the daemon log line `graph task ... runs as sub-agent tsq-graph-grader` for that project task.

### Improvements
36. Serial queue should self-heal: when an execution result goes stale/invalid or its assignment is cancelled, advance the queue automatically instead of needing a manual dismiss.
37. A blocked execute (waiting for approvals) must not freeze unrelated grading; consider parking it outside the serial queue.

- 10:50 VERIFIED live: the first graph task after the release (project, cc-nasty) started as `agentSetting: tsq-graph-grader` and received the full 11162-char prompt intact.

## 2026-11-20 11:05 — steps waiting for the owner stay in pending input

- New `syncInboxStatus` (runs each tick, commit e1bca65, deployed): inbox tasks of `blocked`/`error` execute/undo/continue steps (and non-stale planning steps) are set to `waiting_input` instead of staying `done`; they return to `done` when the step is answered, cancelled or dismissed. Stale planning/review steps stay `done` (noise). Repair steps excluded.
- Verified in production: the buyer-interviews execute task is now `waiting_input`; the stale blocked project step stays `done`. Because the task is open again, `can_reply` is true and the owner can reply with the approvals directly in the inbox thread.
- Test extended (done → tick → waiting_input).

### Improvements
38. The portal could badge `waiting_input` graph tasks "Needs your approval" with the list of missing approvals pulled from the result.

## 2026-11-20 11:50 — generic approval flow (needs_input) shipped

- Contract: optional `needs_input` {title, reason, fields[radio|checkbox|text]} on execute and continue results (only valid with outcome/decision `blocked`), validated by the closed schema + cross-field checks (`checkApprovalRequest`); agent prompt tells agents how to ask. Parser `extractApprovalRequest` (worker `src/approval.ts`, portal `lib/approval.ts`) accepts whole-message JSON/YAML or a fenced block (regexp-gated).
- Status decision: keep tasks open while a request is pending; the owner of the follow-up closes. Non-graph replies with a request are not auto-closed (daemon close route); graph tasks free the CLI session but stay `waiting_input` via `syncInboxStatus` until the answer is accepted.
- Inbox: `ApprovalForm` (radio/checkbox/text, required + length checks) answers with a YAML `approval_response` through the normal reply path; agent JSON/YAML replies render as a headline + rows with a Raw toggle (`formatBody`). Tests: 295 worker, portal lib tests.
- Found while verifying: someone replied with the interview approvals at 11:08 (continue queued), but my earlier Dismiss had marked the execute's serial-queue entry done, so the continue could never reach the queue head. Fixed (7118ce4): `dismissStale` now runs every tick (stale blocked planning steps are auto-dismissed) and keeps/reopens the execution entry an open continue needs. Watching for the continue task to dispatch (it should run as `tsq-graph-executor`).

### Improvements
39. Do not let manual queue edits strand a pending continue: reopen logic is now automatic; add an engine test that dismisses with an open continue.

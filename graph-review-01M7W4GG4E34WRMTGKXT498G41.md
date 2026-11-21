# Nasty Bottle graph chain review

Graph: `01M7W4GG4E34WRMTGKXT498G41`. Initial production snapshot: 2026-11-20 23:03 Asia/Singapore. Work: main branch, main worktree.

## Findings

- Reviewed all 25 published action edges and their 38 execution results, following assignment ancestry through planning, independent merge, continuation, grading and projection (155 assignments; 76 graph nodes). Of 38 executions, 29 report blocked and 9 report complete. Complete means the bounded step finished, not that business predicates passed.
- Immediate scheduler deadlock: serial queue entry 82 points to continuation `01M7WMWNWDE38TSFWNB7NE1DWD`, result `01M7WPRC08CK3RZ1PJ9P43QMV3`, inbox task `01M7WPP8HGWPVXT2TR5TSQ9XXZ`. Result rejected after restart claimed an unverified baseline; assignment remained blocked. Queue reconciliation did not park blocked/error assignment continuations, holding 17 later entries. No active jobs. Fix parks the item without executing or accepting it; pending repairs keep their queue ownership.
- Owner answers were lost across execution restarts. Example: `01M7WG67P8228WSD00VNPVNJW3` contains the instruction-location answer and waiver. Descendant `01M7WPP8747KFAPQTSFQ7C62AQ` contains only the later inventory answer and blocks again on those instructions. Another example is firmware execution `01M7WJ5AWMPQ5YVD59ZQ9TF2BG`. Fix preserves answers and recovers legacy same-role restart ancestors, without broadening the plan.
- Budget is not the current blocker: attempts 152/10000; declared execution cost 5667/100000; recovery reserved 0/25000. These are engine accounting units, not verified cash spending.
- Business progress remains unverified. Stored readbacks report zero reservations, zero buyer interviews and no verified paid demand. Nine complete steps are local drafts, acceptance checklists, sitemap reconciliation and local-only instrumentation. Production reservation events are still absent in the stored readback; local instrumentation is commit `429d5c54102fcc423972b46ff88e568822d33f1a` in `/tmp/nasty-reservation-funnel`, with deployment explicitly outside that plan.
- Earlier account blockers include disconnected Gmail, Search Console sign-in and obsolete browser profile/endpoint commands. Current Chrome Profile 2 is xajik0@gmail.com (display Igor/Xajik), already signed into TaskSquad. This does not establish login to the brand accounts or their business approvals.
- The graph has repeated low-goal-impact planning branches (RFQ/social/checklist drafts and repeated analytics plans). Local quality grades of 0.8–0.9 do not establish sales; reviewed projections report much lower goal relevance (for example 0.04 for social drafts). Prioritize restoring prerequisites and reviewing existing deliverables before drafting more.

## Reviewed chains (25 actions)

Each entry records the published action and all execution attempts in this snapshot. Follow the assignment parent links for the complete planning/merge lineage.

1. **Run buyer interviews and willingness-to-pay test** — edge `01M7W4WEGXZFG0VJEXP59D1AZ8`.
   From `01M7W4GG4ESMSVYCX3JXJ91M5C` (Observed start) to proposed state `01M7W4WEGXXP02QZFJ9G4EF5AP`.
   - Execution `01M7W4WEHATFZA43PQZY89W6ZH`; result `01M7W58RA6WD4PJ4QZRM3BNH8K`: **blocked** — Production outreach access is unavailable. The Gmail connector is disconnected. Buyer outreach and the production baseline could not be verified.
   - Execution `01M7WHNEV3ZB1BH93GZ3ED2XA4`; result `01M7WHSNTNDQPHXNVKS5BBVFGW`: **blocked** — Interview draft saved; buyer recruitment blocked. Production D1 has zero reservations. Profile 16 access failed, and the CDP fallback returned HTTP 404. No outreach was sent.
2. **Run a gated production and fulfillment pilot** — edge `01M7W529CA81K2149PM4ZSR5EC`.
   From `01M7W4GG4ESMSVYCX3JXJ91M5C` (Observed start) to proposed state `01M7W529CA4HB1C9FTMT9MGHXQ`.
   - Execution `01M7W529CSGH817QDN9YDSYTJF`; result `01M7W5APWDZPDC2E9VA8DHEFTS`: **blocked** — Production pilot blocked at prerequisite gate. Approved production inputs are absent from the supplied baseline. No commitments were made.
3. **Configure operational alerts** — edge `01M7W52PJCAKTXWQV3TQAZ7JX6`.
   From `01M7W4GG4ESMSVYCX3JXJ91M5C` (Observed start) to proposed state `01M7W52PJC3BKNR7Z47413NR0D`.
   - Execution `01M7W52PKBZPWT1MANQX170W9K`; result `01M7W5CSFY8W693MP139FJ32CJ`: **blocked** — Cloudflare alert configuration requires access. Required local instructions were unavailable, and no connected tool exposes Cloudflare notification management.
4. **Audit account access and baseline metrics** — edge `01M7W549209CSP9Q912Y7YGG2Z`.
   From `01M7W4GG4ESMSVYCX3JXJ91M5C` (Observed start) to proposed state `01M7W54920TBX49QAF2JDVRK1D`.
   - Execution `01M7W5492E0KZYZ2GGTAX950XW`; result `01M7W5EXCDCR3WY48E10NKGRED`: **blocked** — Audit blocked by missing prerequisites. Gmail is disconnected. Amplitude access works. Required local instruction files are unavailable.
5. **Draft comparable RFQ package and supplier longlist** — edge `01M7W894RVQC1RSK7FJAH36PAV`.
   From `01M7W5AQAGWANW5RPKBXDH5YRM` (Production pilot blocked at prerequisite gate) to proposed state `01M7W894RVV6NA2N60F9A1Z2CG`.
   - Execution `01M7W894S7QFHJ232YQXXNF8EJ`; result `01M7W8KARNFXFND8DNX1H8YFHY`: **blocked** — Required workspace instructions unavailable. The referenced RTK.md and browser-harness SKILL.md could not be read.
6. **Verify outreach channel and send RFQs** — edge `01M7W89K8A7583PXV8E3M1CZDH`.
   From `01M7W58RNZ5HTRDM69AGBWQ3CQ` (Production outreach access is unavailable) to proposed state `01M7W89K8AK4VP91GDVXAG834G`.
   - Execution `01M7W89K91ZBCTE19TEEJCA8Q7`; result `01M7W8NFD93590K74VGWM799FS`: **blocked** — Outreach prerequisites unavailable. No messages sent. Required instruction files could not be read, and approval prerequisites remain unverified.
7. **Establish Production prototype and market-entry readiness gates** — edge `01M7W8BED22JXBRBR39DW3MPG0`.
   From `01M7W5AQAGWANW5RPKBXDH5YRM` (Production pilot blocked at prerequisite gate) to proposed state `01M7W8BED2QM339BH7E14NJRB1`.
   - Execution `01M7W8BEDNFJ3HKQMW2M0T94T6`; result `01M7W8Q4VBFWJ09YHJNJ6YK4R5`: **blocked** — Required local instructions are unavailable. Stopped at the first plan step because both required instruction files could not be read.
8. **Verify social account access and baseline** — edge `01M7W8D1FWQKBZGYENMTZQBEPD`.
   From `01M7W4GG4ESMSVYCX3JXJ91M5C` (Observed start) to proposed state `01M7W8D1FW98SZFFKR5AF4JRZ5`.
   - Execution `01M7W8D1G68DEHC79TPWPPWFJ9`; result `01M7W8SB3WSEK6JHDXB50TB9EF`: **blocked** — Required workspace instructions are missing. Read-only execution stopped because required instruction files could not be read.
9. **Publish creative and record acceptance evidence** — edge `01M7W8F5BB31AA8GJWB03KYMNE`.
   From `01M7W4GG4ESMSVYCX3JXJ91M5C` (Observed start) to proposed state `01M7W8F5BBBNSRVZRY8X98DCW7`.
   - Execution `01M7W8F5BNS5BH3SB2RPJZ3Q3M`; result `01M7W8H4CQ4W1GD53M4SX564C6`: **blocked** — Publishing prerequisites are missing. Approved creative, verified channels, and production evidence access were not provided.
10. **Draft firmware and app acceptance criteria** — edge `01M7WBSMYZR7RW9X88SCNFP0HT`.
   From `01M7W4GG4ESMSVYCX3JXJ91M5C` (Observed start) to proposed state `01M7WBSMYZN5ZD8W4RHCTCMM94`.
   - Execution `01M7WBSMZD6KR9C98EKT1KGDPD`; result `01M7WC38V2Q2GPDTZA8SXSNR3C`: **blocked** — Required instruction files are missing. Stopped at the first plan step because both required instruction files could not be read.
   - Execution `01M7WG493ZC1EWHT7WSAA7Z77B`; result `01M7WGED6N002SKABPDSD2XMT5`: **blocked** — Criteria drafted; external merge review blocked. Drafted and read back numeric thresholds and evidence types for all five areas. Opening an external review conflicts with the plan's local-only effects.
   - Execution `01M7WJ5AWMPQ5YVD59ZQ9TF2BG`; result `01M7WJ6KX8Y2D3N1XHRR8SFTEB`: **blocked** — Required instruction files are unreadable. The plan requires stopping if either instruction file cannot be read. Both paths returned file-not-found errors.
11. **Draft a separate Production analytics and privacy acceptance gate** — edge `01M7WBV7ZD3VS3KKR6GK87PTK0`.
   From `01M7W5EXR14688P14826GHJJ3C` (Audit blocked by missing prerequisites) to proposed state `01M7WBV7ZDR1EBTHSFH9BV9TSP`.
   - Execution `01M7WBV7ZTPMR2TMSBKVB9K94H`; result `01M7WC5AD2YDVK63Q0QK5WZXPX`: **blocked** — Required instruction files unavailable. Stopped at the first plan step without writes.
   - Execution `01M7WG27MEMV7VVQFPHH7KBNH7`; result `01M7WGAW1Z3EGHD6HBB8WMZEFN`: **blocked** — Source milestone access required. Stopped at step 2 because the combined technology milestone could not be identified. No writes were made.
   - Execution `01M7WJCWHEDKDB066CQ5DDD43K`; result `01M7WJKTBT84ZQEMSQDMX4R185`: **complete** — Production analytics and privacy gate drafted for local review. Saved a standalone gate and evidence checklist on a separate local review branch. Merge and acceptance remain pending.
12. **Draft commerce end-to-end acceptance gate** — edge `01M7WBVNDRMTECMMY9KPG7MXYR`.
   From `01M7W4GG4ESMSVYCX3JXJ91M5C` (Observed start) to proposed state `01M7WBVNDRX3MYGJ4J3MCA4BBH`.
   - Execution `01M7WBVNE75VP60GTC9H8Z1FCY`; result `01M7WC79GZYPYCV049D8NE9NM7`: **blocked** — Required RTK.md is unreadable. Stopped at the first prerequisite. No draft or review request was created.
   - Execution `01M7WFYAGB14MMZAQH2TH6ZTKW`; result `01M7WG3HHFQBT4QCQX6ZRBWTXZ`: **complete** — Six-stage acceptance draft opened for separate review. Draft read back; all six stages include pass conditions and trace evidence. Review remains open, draft and unmerged.
13. **Verify search ownership, sitemap and indexing monitoring** — edge `01M7WBX6GSNG1Q2D0MQJ8T3W3T`.
   From `01M7W4GG4ESMSVYCX3JXJ91M5C` (Observed start) to proposed state `01M7WBX6GSA53XPBV36YWN9H52`.
   - Execution `01M7WBX6H843RAASYSG049Z1R6`; result `01M7WC9RPZJMC2WH7FH3DWBKHY`: **blocked** — Required execution instructions are unavailable. The referenced RTK.md and browser-harness skill files could not be read.
   - Execution `01M7WG077FSNKB6EGRWFCT3E72`; result `01M7WG7D1FBCKKPAPAB9PAGHTR`: **blocked** — Google Search Console requires sign-in. The live sitemap is accessible, but the Nasty profile reached a Google login page. Execution stopped before any changes.
   - Execution `01M7WJ17T0AMHJ87XY12PSWDHJ`; result `01M7WJ3QXF3JE5BAE1XVMQ7FZ8`: **blocked** — Chrome profile access blocked by macOS. Sitemap returned HTTP 200 with 20 URLs. Console access could not be tested because Profile 16 could not be opened.
   - Execution `01M7WJEYSXXYQXSMV1RZ9YBGYE`; result `01M7WJX57P9195DK6PGGJWJHE2`: **blocked** — Browser debugging endpoint remains unusable. The sitemap returned HTTP 200, but console access could not be established.
14. **Prepare Production milestone amendments for separate merge review** — edge `01M7WBZBQRJNV7QNTC2NCRK235`.
   From `01M7W8Q57VPTEM3P86ZPHKFDS6` (Required local instructions are unavailable) to proposed state `01M7WBZBQRZB4NVAVMWM0CN58R`.
   - Execution `01M7WBZBR3CNC9F6Y2QK0N4E7S`; result `01M7WC1BPNAG7747M7DGDAQJN5`: **blocked** — Required instruction files are unavailable. Stopped at the first plan prerequisite. No draft or review record was created.
   - Execution `01M7WG67P8228WSD00VNPVNJW3`; result `01M7WGJTD63ZTTXKR310HV3P80`: **blocked** — Complete Production milestone inventory is unverified. Instructions were resolved, but plan step 2 could not establish a complete inventory with IDs, contents and revisions.
   - Execution `01M7WPP8747KFAPQTSFQ7C62AQ`; result `01M7WPT2A7V7WQSWW0WGCMBFJG`: **blocked** — Required instruction files are unavailable. Stopped at plan step 1. Both required file reads returned file-not-found errors.
15. **Sitemap and robots read-only check** — edge `01M7WGFHZYNDD9BES5Y41VCJAY`.
   From `01M7WG7D8XH4MB5DX92JQ6X8FP` (Google Search Console requires sign-in) to proposed state `01M7WGFHZYA4ZHMPH0PQ38XZJP`.
   - Execution `01M7WGFJ0D268A57R10EWN8EZP`; result `01M7WGP0J6QPM388B1431DKX36`: **blocked** — Required instruction files are missing. The referenced RTK.md and browser-harness/SKILL.md could not be located.
   - Execution `01M7WJAY155MADK6R4A5DCRHT1`; result `01M7WJFPN66A0XTVCF65P6H66J`: **blocked** — Sitemap baseline changed from 4 to 23 URLs. Stopped after read-only fetches because the production sitemap differs from the approved baseline.
16. **Draft supplier RFQ locally** — edge `01M7WGG1GP0W2W9BSPCSGS7V7A`.
   From `01M7W8NFRZN58ETS74WBTVQ5YJ` (Outreach prerequisites unavailable) to proposed state `01M7WGG1GPCE4VWFPS06ZS30AC`.
   - Execution `01M7WGG1H8N93CK45HPKZEE3ZN`; result `01M7WGM6FM769WGHNGEX45RPGF`: **blocked** — Required workspace instructions are missing. The RFQ draft was not created because referenced instruction files could not be read.
   - Execution `01M7WJ8V3JE4GBNA8JYHKSG5ZN`; result `01M7WJCCDW7KCRRSQ851QPN65T`: **complete** — Unapproved supplier RFQ drafted locally. Created and read back docs/rfq.draft.md with all required sections. No supplier contacted or spend incurred.
17. **Reconcile sitemap baseline 4 vs 23 URLs** — edge `01M7WJPS8V13EM4D5PQ4NAHQVC`.
   From `01M7WJFQ1SQE25RG93P3M21A38` (Sitemap baseline changed from 4 to 23 URLs) to proposed state `01M7WJPS8VXZB56EHZTKZPSTYR`.
   - Execution `01M7WJPS9D9S08F7CV9945MK5Y`; result `01M7WK0BYC1315D7AY4JR0ZWMP`: **complete** — Reconciled sitemap baseline: 20 pages and 3 image locations. All 20 page URLs match tracked routes. All 24 distinct page and media URLs returned HTTP 200.
18. **Read-only funnel baseline from Amplitude** — edge `01M7WJR55BF1HNBXWX351KESY8`.
   From `01M7W5EXR14688P14826GHJJ3C` (Audit blocked by missing prerequisites) to proposed state `01M7WJR55B411YYB3007YTRS1S`.
   - Execution `01M7WJR55TYYCY9D231M44JPFZ`; result `01M7WK7SBW1GKVQSN7MQNT98WY`: **blocked** — Reservation events are missing from Amplitude. Measured page-view users and confirmed D1 has 0 reservations. Reservation starts, completions and consistency remain unverified.
19. **Draft unapproved launch posts for X and Reddit** — edge `01M7WJRN0KKZ9YSXEHEXCJDECE`.
   From `01M7WJCCQ8WRT2HJE8XZP96E3B` (Unapproved supplier RFQ drafted locally) to proposed state `01M7WJRN0K1B233JZ7QV9ZMDS2`.
   - Execution `01M7WJRN11JK3AXH22XHQ2YCD8`; result `01M7WK30TVXK6PVX828YZ2527E`: **complete** — Unapproved X and Reddit drafts created. Created and read back docs/launch-posts.draft.md. Both drafts state that the product is a concept and reservations are not orders.
20. **Draft X and Reddit posts for approval** — edge `01M7WK441AR47HDTB3Q8DJZJ7T`.
   From `01M7W8H5KFT2ZAZWJ590R3JTYE` (Publishing prerequisites are missing) to proposed state `01M7WK441A46RNENBCTDE5TQ2K`.
   - Execution `01M7WK441S781RCXJDXTXFPEMW`; result `01M7WKEKHFJB712AECN61TB1J4`: **complete** — Five unapproved social drafts created. Created docs/social.draft.md with 3 X drafts, 2 Reddit drafts, tagged links and subreddit rule notes.
21. **Read-only reservation funnel baseline** — edge `01M7WK4MYNDT84Y4WCZCT5M1SW`.
   From `01M7W5EXR14688P14826GHJJ3C` (Audit blocked by missing prerequisites) to proposed state `01M7WK4MYNPHMMB90CNQ3K6D86`.
   - Execution `01M7WK4MZ32AWN59QE5ZHXQ224`; result `01M7WKK9P8W6P49EP1EFJEWGP2`: **blocked** — Baseline saved; intermediate funnel is unmeasurable. D1 has 0 reservations. Amplitude reports 31 unique page-view users, but reservation-start tracking is absent.
22. **Add reservation funnel events on a local branch** — edge `01M7WPW7BQQ4ASJ1QBF0XVTTW7`.
   From `01M7WK7SKDQN4G98KH64QPVZRN` (Reservation events are missing from Amplitude) to proposed state `01M7WPW7BQBRKAZH9EYNPMG945`.
   - Execution `01M7WPW7CYCCFA2KMJ60491N7F`; result `01M7WQ49YMY3XMSKJV8JDBPMKA`: **complete** — Reservation funnel instrumentation committed locally. Added both events and duplicate-submit protection. Build and 39 tests pass. Production baseline remains unchanged.
23. **Self-review social drafts against a checklist** — edge `01M7WQ22QQ73FESCDNYBRWZCG1`.
   From `01M7WKEKQXF35HKTNWGKT508V1` (Five unapproved social drafts created) to proposed state `01M7WQ22QQSY8S9YEW3ZQRB3DR`.
   - Execution `01M7WQ22R3SHDE4QTAF1YJWP8B`; result `01M7WQ74J9D11CFBM3WA4658A6`: **complete** — Local draft review recorded. Reviewed five primary drafts and two legacy drafts. Source hashes are unchanged; nothing was published or sent by this execution.
24. **Add reservation funnel events to Amplitude on a local branch** — edge `01M7WQ42YS00GHPT9SFS2ZR48J`.
   From `01M7WK7SKDQN4G98KH64QPVZRN` (Reservation events are missing from Amplitude) to proposed state `01M7WQ42YSEW3XYBHKS408XYN6`.
   - Execution `01M7WQ42ZPBKQS0W73EK38XEP5`; result `01M7WQ82Q2V44JM2N49TYQ4BC7`: **blocked** — Required browser harness instructions are missing. Baseline file and working tree inspected. No code, branch, deployment, or external changes made.
25. **Prepare an approval packet for the unapproved drafts** — edge `01M7WQ60Y047F2S06VVFXG5ZN1`.
   From `01M7WKEKQXF35HKTNWGKT508V1` (Five unapproved social drafts created) to proposed state `01M7WQ60Y04TTVMT43CX8R7NJ1`.
   - Execution `01M7WQ60YE2DS3YR5E1VD78XE7`; result `01M7WQBNSPY63AHV7ENBXBCQ3S`: **complete** — Local approval checklist prepared. Read back all nine review items across four source files; every item has status UNAPPROVED.

## Follow-up schedule

- TaskSquad conveyor `01M7WQQ5G00JVZ7DDXB6SQ443J`, project TaskSquad, agent cdx-ts; hourly at :00 Asia/Singapore, first 2026-11-21 00:00, maximum 10 runs, expires 2026-11-21 09:00:01 Asia/Singapore. Each run checks for an existing review before beginning the next sequential chain; works on main/main worktree and fixes/tests/pushes confirmed bugs. No new chains after 09:00.
- Next review: check queue 82 has advanced after deployment, then follow the pending continuation at sequence 83 (`01M7WMXD4HFPGWVSZ951XWPVK9`) and subsequent work. Verify current chain inputs retain earlier owner answers, and distinguish current missing permissions from already-resolved questions.

## Validation and deployment

- Worker `make test`: all 306 tests pass (28 files). Regression cases cover blocked/error continuations, repair queue ownership and reopening, repeated owner answers, legacy restart recovery, and distinct short answers.
- Worker `make check` and `make build`: pass.
- Pushed `619e717` to main; GitHub Actions Deploy Worker run `44760086240` succeeded.
- Production verification at 23:08 Singapore: queue 82 is done, assignment remains blocked (no unsafe retry); queue 83 dispatches continuation `01M7WMXD4HFPGWVSZ951XWPVK9` as inbox task `01M7WR02P16TK6YNSRWF5G66R7`. Graph budgets advance 152→153 attempts. Chrome Profile 2 visibly confirms one active job and 153/10000 attempts.
- Follow-up hardening preserves short owner answers as distinct blocks: `No` must not be discarded merely because a later answer contains `No additional changes`.
- Next chain cursor is now the running continuation at queue 83; after it resolves, inspect sequence 84 onward. Business progress is still unverified; dispatch resumption is not a sale.


## 2026-11-21 10:51 — resumed closeout

- The 09:00 review window has ended. Scheduler emitted 10 tasks (repeat_counter=10), but the first review task `01M7WTPR225RZQS2TFB791NFB3` hit the Codex usage limit at startup and remained running. Its terminal explicitly shows the usage-limit error; supervisors repeatedly timed out. Nine later reviews queued behind it, so those hourly reviews did not execute. Closed the nine expired pending tasks, then closed the stuck first task; daemon subsequently marked that first task failed. No schedule extension.
- Graph advanced to 190 attempts, 39 allocations, declared cost 5667.5 and recovery reservation 0.2. Serial queue is empty. There are 20 pending executions, but the executor agent remains reserved by interrupted attempt `01M7WR3WK5HEMF3FDD4XDEC1CV`. It timed out and received termination acknowledgement at 01:11:39 Singapore.
- Reconciliation `01M7WZ0AM10EXRP69TXJVPXQTP` returned unknown and is blocked. Its result explicitly says it has no process-inspection or git-diff tools. Both daemons incorrectly mapped reconcile to `tsq-graph-grader`, whose installed Claude definition allows only Read/Grep/Glob and says to judge supplied evidence only. Source fix removes that override for reconcile in Go and Swift; the configured CLI receives the reconciliation prompt directly. Grade/project remain mapped to the independent grader. This source change requires a daemon update before affecting installed binaries; it does not manufacture restoration evidence or release the unresolved reservation.
- Short-answer preservation fix pushed as `4e0543a`; worker deployment `44858173723` succeeded. Worker checks: 306 tests, TypeScript check and dry-run build pass.
- Go daemon `make test`: pass. Swift build and macOS full `make test` suite pass (exit 0). Reconcile mapping regression is covered in both Go and shared Swift tests.

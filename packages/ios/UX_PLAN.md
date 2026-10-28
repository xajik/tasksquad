# iOS usability plan

Review date: 2026-10-28. Scope: TaskSquad native iOS app in the existing iPhone 17 Pro / iOS 26.1 simulator. This is a baseline audit and implementation plan; production UI behavior has not been changed.

## Intended experience

Make it easy to answer three questions: **What needs me? What am I reading? What can I do next?** Keep the TaskSquad design tokens and native navigation. Put the task or note ahead of administration, metadata, and execution settings.

Reference principles, rather than pixel copies:

- [Notion mobile workspaces](https://www.notion.com/help/workspaces-on-mobile): persistent access to frequent destinations and creation, workspace switching at the workspace name, editing tools beside the keyboard, additional actions in an overflow menu.
- [Notion mobile conventions](https://www.notion.com/help/notion-for-mobile): visible touch controls and one content column on a phone.
- [Muse, now Allume](https://allume.com/): a quiet content surface, simple interactions, and collecting material before organizing it. Apply that focus to reading and composing; a spatial board is not needed for a task inbox.

These references inform the proposals below. Neither reference app was installed or interactively tested in this session. Mobbin search was unavailable because the connected account requires a paid plan.

## Evidence and method

Inspect `PortalHomeView.swift`, `MobileNavigation.swift`, `MobileEditor.swift`, `MobileRecordDetail.swift`, `MobileTheme.swift`, `PortalTerminalScreen.swift`, and the shared field, validation and policy definitions. Run the existing HTTP/WebSocket fixture contract suite through `make e2e-contract`; do not send work to a production agent.

Three added baseline journeys in `TaskSquadUITests/PortalFlowTests.swift` capture:

1. Empty task submission, required subject/agent validation, optional settings, and successful creation without a message.
2. Cancelling and reopening a reply, restoring its text draft without sending it, and documenting that the selected image is not restored.
3. Creating a note, opening its secondary action menu, and editing the existing content.

Fresh screenshots and machine-readable results belong in `screenshots/usability-audit/`. Final run results are recorded below when testing completes. Functional passing tests do not establish that a workflow is understandable to a first-time user.

## Prioritized changes

### P1 — Make creating work understandable

**Observed in code and fresh screenshots:** task creation exposes subject, agent, message, a separate image section, scheduling, auto-close, token controls, and close steps (`24-task-editor.png`). Subject and agent are required, but their presentation does not use `field.required`. The Send button permits invalid input; the first missing requirement appears only after submission. In `25-task-required-subject.png` the error area consumes a large part of the editor rather than appearing beside Subject. In `26-task-options.png`, “Agent is required” remains after choosing an agent, until the next submit. Single-line fields lose their placeholder label once filled. Token saving level remains visible when Save tokens is off, and the close-steps placeholder truncates.

**Change:** use a dedicated task composer. The initial surface contains a persistent **Subject · Required** label, **Agent · Required** selector, and message editor marked optional. Place one Attach action beside the editor; it opens Photos / Files and displays selected image thumbnails, count, removal, and limits. Put scheduling behind **Send later** and execution settings in a collapsed **Advanced** section. Show dependent options only when their controlling setting is enabled. Preserve all payload keys and defaults.

Validate next to the relevant field, focus/scroll to the first error, clear resolved errors as fields change, and announce the error for assistive technology. Keep any request-level banner compact so it cannot consume the editor's writing space. Show a visible sending state. If Send is disabled for missing fields, show the reason beside the controls so users can discover what is needed. Keep the existing draft after HTTP failure.

**Draft gap:** `MobileDraftStore` saves field values, while selected images live only in the editor's `@State`. Cancelling/reopening restores text but loses selected attachments. Persist attachment drafts in a scoped local file store, with cleanup on send/logout/discard, or explicitly warn before discarding images. Do not claim the complete draft is saved while only its text is retained.

**Agent availability:** distinguish an offline agent that can queue a task from a Portal agent that must be online and eligible. Explain each case. Do not filter ordinary tasks to online agents or silently substitute an agent. A remembered selection must be scoped to the account/project and still exist in that project.

**Acceptance:** a user can identify the two required inputs before pressing Send. Both invalid submissions create zero remote tasks. A subject and chosen agent still suffice; adding a new message requirement would change the product contract. Optional controls require no interaction for an immediate task. At 375pt width and accessibility text sizes, every field and error remains reachable with the keyboard visible. Images and text survive failed submissions.

**Files:** `MobileEditor.swift`, `PortalHomeView.swift`, `MobileDraftStore.swift`; introduce an iOS task composer if that keeps the generic editor small. Reuse shared `WorkspaceEditor.payload` validation. Change shared APIs only if necessary and test both Swift clients when doing so.

### P1 — Prioritize the work that needs a human

**Observed:** Inbox rows show title, status badge and creation age, with the same row treatment for each task. They do not show a reply preview or assigned agent. Common filters sit inside View options → Status → option. A filtered empty list uses the same “No inbox” guidance as a genuinely empty project.

**Change:** keep the row title strongest, followed by a short latest-message preview when the API provides it. Put agent and relative update time on one muted metadata line. Use explicit **Needs your input**, **Running**, and **All** quick filters with counts only when complete data is available. Retain the full status/origin menu for less common filters. Make active scope visible and offer **Clear filters** directly in a no-results state. Distinguish no tasks, no search matches, filtered results, loading, and failed loading.

Start with explicit filters rather than silently changing chronological order. If prioritizing waiting tasks by default is later chosen, use labeled sections and keep the user's selected view stable. Current records are paginated: do not claim local counts are project totals or that filtering the loaded page searches the entire project.

**Acceptance:** the visible view explains its scope without opening a menu. One activation selects a common status. A user can clear a filter from the empty state. Readable titles wrap at large text sizes. No invented previews, unread state, timestamps, or total counts; add API support as a separate change if necessary.

**Files:** `PortalHomeView.swift`, `MobileNavigation.swift`; inspect `WorkspaceStore.visibleRecords` and API pagination before adding counts or global search.

### P1 — Let users read and reply in context

**Observed:** the record header is a separate List section, including separate title, badge and Agent rows. Fresh `04-conversation.png` and `12-dark-large-conversation.png` show how this separates the metadata from the message and pushes the conversation down, particularly at accessibility text sizes. Reply uses an icon-only floating action that opens a full editor sheet with Images and scheduling sections. Notes elevate Add comment while Edit is in the overflow menu; `08-note.png` also shows a redundant Content heading between the title and prose.

**Change:** group task title, status and agent into one compact header. Give message content the main reading width. Add a labeled **Reply…** composer dock on task conversations that expands in place, with Send and Attach beside the keyboard. Keep scheduling as a secondary action and preserve existing draft scoping. Scroll to the new reply after successful send without pulling the reader away while they review older content. Put pending permission choices next to the request and keep them visible/reachable. Collapse verbose tool details behind an inspectable disclosure rather than a six-line truncation with no expansion.

For notes, make **Edit** visible in the toolbar or allow an explicit tap-to-edit entry point. Render the note as a document, with comments below its body. Keep **Add comment** visible as a secondary action near Comments. Do not enter edit mode on ordinary text selection.

**Acceptance:** replying does not require a new full-screen sheet; draft and failure behavior are preserved. Opening a note exposes Edit without opening overflow. No message content is covered by the composer. Large text, code blocks, long messages and permission choices remain usable. Destructive operations stay in overflow with specific confirmation copy.

**Files:** `MobileRecordDetail.swift`, `MobileEditor.swift`, `MobileTheme.swift`. Shared Markdown changes affect macOS too.

### P2 — Give navigation a hierarchy

**Observed:** the compact drawer has 12 similarly weighted destinations followed by Projects and Account. Projects appears after the other destinations in the scrollable list. The toolbar project name is informational, so switching requires opening the drawer, choosing Projects, then a project. Library types are hidden inside View options.

**Change:** put an actionable current-project switcher at the top of the drawer and provide access from the root toolbar project name. Group the drawer into **Work** (Inbox, Notes, Portals), **Automation** (Conveyor, Planner, Supervisor), **Resources** (Library, Memory), and **Manage** (Agents, Members, Analytics, Settings). Keep Account in a stable utility area. On Library, show a named Skills / Sub-agents / Commands selector rather than overloading a filter icon.

Prototype persistent compact navigation for Inbox, Notes and More only after checking space consumed by the conversation composer and search. The grouped drawer is the first implementation; a tab bar is a separately reviewable navigation change. Preserve the regular-width iPad sidebar and native Back gestures.

**Acceptance:** switching a project from a root screen needs two command activations: project name, project row. Work destinations are visible before management. Back from utility screens preserves the record. Background polling remains scoped to the visible route; switching projects clears old content and editor state.

**Files:** `MobileNavigation.swift`, `PortalHomeView.swift`. Retain stable accessibility identifiers or update all fixture tests in the same change.

### P2 — Establish native spacing rules

The goal is consistent grouping and alignment, not adding padding to every view. Keep the 4pt grid from `DESIGN.md`; the following are proposed iOS layout tokens, not measurements of reference apps.

- Phone content inset: **16pt** at compact widths, **20pt** when space permits. Keep titles, body text, form labels and dividers on the same leading edge.
- Between related icon/text elements: **8pt**; label to field/error: **4–8pt**; row/content padding: **12–16pt**; between semantic groups: **24pt**.
- Interactive target: at least **44 × 44pt**. A small icon can sit inside a larger target. Let rows grow with Dynamic Type rather than fixing their height.
- Use native body text for reading, headline for row subjects, a title style for the one record title, and caption for timestamps. Do not shrink text to achieve density.
- The existing FAB is **56pt** with **16pt** outer padding, placed in a bottom safe-area inset. Replace it with a labeled contextual action where the meaning is ambiguous; retain a single primary action. Avoid stacking the old FAB above a new reply dock.
- Notes and conversations: start with a centered **680pt maximum reading width** on iPad, with a 24pt minimum gutter; treat this as a prototype value to validate on device. Terminal output remains full width.
- Give the editor flexible writing space. Do not replace the current 120pt TextEditor minimum with a giant fixed empty area. Collapse secondary sections to bring the next meaningful action closer.
- Keep system safe areas, keyboard avoidance, contrast and existing semantic colors. Use restrained separators rather than wrapping every content group in a card. Add spacing tokens in the iOS layer and document deliberate differences from web density.

**Acceptance:** compare fresh screenshots at 375pt, the standard iPhone, iPad, light/dark and accessibility3. All targets and last content can be reached. Use horizontal scrolling inside code or terminal regions rather than making the whole screen scroll sideways. Check landscape with the keyboard visible.

**Files:** `MobileTheme.swift`, `MobileEditor.swift`, `PortalHomeView.swift`, `MobileRecordDetail.swift`, `MobileNavigation.swift`.

### P2 — Simplify advanced forms and terminal controls

**Observed in code:** conveyor creation presents numeric hour, minute, weekday and day-of-month inputs together with a freeform timezone. Terminal uses a connection toolbar, separate text input, and a horizontally scrolling key strip; some buttons have no explicit 44pt target.

**Change:** show a time picker, timezone selector, and only the frequency-relevant day field. Put run limits and end conditions behind an optional section. Keep the outgoing schedule contract unchanged. For terminal, preserve the full output area, use one clear keyboard entry mode, and enlarge keyboard/reconnect/key-strip hit regions. Maintain Esc, Tab, Ctrl-C, reconnect and Close access in landscape.

**Acceptance:** daily schedules never ask for a weekday or month day; timezone is explicit; validation focuses the appropriate control. Terminal disconnect/reconnect, resize, background recovery and input still pass the socket tests. Measure remaining output height on the smallest supported phone before changing toolbar height.

## What is actually required to perform an action?

Requirements below describe the current client and shared policy, not a proposed API change.

- **Create task:** selected project, subject, agent. Message and images are optional. A regular task may be queued for an offline agent. Keep advanced defaults untouched unless the user expands them.
- **Reply:** task, nonblank message; images optional, future date only when scheduled. Do not assume image-only replies are supported by the present validator.
- **Open Portal:** eligible Pro account, selected project, eligible online agent, and fewer than three live sessions. Explain the blocking reason; do not send the user to an empty picker.
- **Create note:** selected project and title. Content and tags are optional. **Edit note:** open the note and explicitly choose Edit; commenting should not obscure editing.
- **Convert/critique note:** an agent; instructions optional, include-comments preference retained.
- **Create conveyor:** subject, agent, message, frequency, valid time and timezone; weekly/monthly require the corresponding day. Show requirements conditionally.
- **Create planner:** name and at least one named phase, with valid retries. Default harness/sub-agent selections are optional.
- **Manage project/resources:** the appropriate project role. Continue hiding disallowed mutations and explaining empty/unavailable states without exposing purchase links.

Command activations from the relevant root or open record, excluding typing/focus/scroll: project switch **3 → 2**, note editing **2 → 1**, common status filter **3 → 1**. These are structural path counts, not measured completion times. Reply still needs an entry and Send; the proposed benefit is keeping the conversation in view rather than claiming fewer taps.

## Implementation order and release gates

1. **Composer and validation:** required labels, field errors/focus, dependency visibility, optional settings, attachment behavior. Verify both minimum valid task and retry after failure. Keep the API unchanged.
2. **Reading and immediate actions:** compact task header, reply dock, note Edit, permission requests and expandable tool details. Verify draft isolation, send duplication, failure recovery and keyboard behavior.
3. **Inbox and navigation:** explicit scope, helpful empty states, grouped drawer, project switcher and Library selector. Verify project switching, utility Back, drawer focus, edge gestures and regular-width sidebar.
4. **Remaining forms and responsive polish:** conditional scheduling, terminal hit regions, iPad reading width, typography and spacing audit.

Each step should be independently reviewable with before/after screenshots. Avoid bundling a new tab bar, inbox ordering change, API pagination redesign and editor rewrite into one change.

Existing automated gates: full `make e2e-contract`, focused new journeys, native build, auth/logout, task creation, Unicode/image round trip, HTTP failure/draft retention, status filtering, note/comment flows, project/role isolation, navigation recovery, terminal input/resize/reconnect/close, dark appearance and large text. Add assertions for the new behaviors as each step is implemented.

Additional qualification before shipping: VoiceOver traversal and error announcements, keyboard on small phone and iPad landscape, Reduce Motion, long realistic inbox/conversation data, slow/offline networking, and a real account/daemon. The fixture's one-task baseline is insufficient for claiming scan-speed, global search quality, full accessibility or production performance.

## Test results

Baseline `make e2e-contract`: **passed** on the existing iPhone 17 Pro, iOS 26.1, device `3D5E8AF0-85BC-4141-8E00-1A18AA2162F9`. Xcode reports **28 passed, 0 failed, 1 skipped**: 23 UI journeys, 4 auth/bundle tests and 1 HTTP workflow test. The skipped test is the optional promotional capture requiring `TEST_RUNNER_PROMO_API`. The runner's shared Swift regression suite also passed before the iOS run.

Baseline evidence: `screenshots/usability-audit/baseline-summary.json`, `baseline-tests.json`, `baseline-attachments.json`, `baseline-fixture-events.jsonl` and named PNGs. Local result bundle: `.build/DerivedData/Logs/Test/Test-TaskSquad-2026.10.28_12-46-10-+0800.xcresult`.

The baseline contains **four runtime frame warnings** (“Invalid frame dimension (negative or non-finite)”). All assertions passed. Investigate the transition/layout warning before calling layout qualification complete; no root cause was established in this audit. Hosted tests also emitted duplicate Swift class loading warnings. These are recorded separately from usability findings and were not treated as functional failures.

Focused `make e2e-contract TEST_FLAGS='-only-testing:TaskSquadUITests/PortalFlowTests/test24TaskRequirementsAndEditorLayout -only-testing:TaskSquadUITests/PortalFlowTests/test25ReplyCancellationRestoresTextDraft -only-testing:TaskSquadUITests/PortalFlowTests/test26NoteEditingActionLayout'`: **3 passed, 0 failed, 0 skipped**, same simulator. It confirms the minimum task inputs, invalid submissions without mutation, reply text retention with image loss on cancellation, and note editing through overflow. The focused run recorded three more frame-warning occurrences.

Focused evidence: `screenshots/usability-audit/focused-summary.json`, `focused-tests.json`, `focused-attachments.json`, `focused-fixture-events.jsonl`, and PNGs `24-` through `31-`. Local result bundle: `.build/DerivedData/Logs/Test/Test-TaskSquad-2026.10.28_12-57-20-+0800.xcresult`. Across both Xcode runs: **31 passed, 0 failed, 1 optional skip** (26 UI journeys + 5 hosted tests). Thirty named screenshots were exported. The shared Swift suite ran successfully in both contract invocations; it is separate from these Xcode counts.

`28-reply-keyboard.png` captures focused text input and the Done editing toolbar; a software keyboard is **not visible** in this simulator configuration. It does not qualify software-keyboard avoidance. No new small-phone or iPad run, VoiceOver traversal, or live production run was performed. Those remain explicit release gates.

The Makefile now accepts `EVIDENCE_OUTPUT` and `EVIDENCE_NAME` so this audit can be exported without replacing earlier contract evidence. For example: `make evidence RESULT=<passed.xcresult> EVIDENCE_OUTPUT=screenshots/usability-audit EVIDENCE_NAME=focused`.

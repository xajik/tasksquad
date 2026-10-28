# Usability implementation retest — 2026-10-28

[Browser before/after report](index.html) · [Implementation and original plan](../../UX_PLAN.md)

All runs use production SwiftUI views and customer HTTP/WebSocket transports against the disposable loopback fixture. No production tasks or agents were mutated. The original screenshots and results remain in `../usability-audit/`.

## Passing runs

- **Full iPhone 17 Pro / iOS 26.1:** 30 E2E journeys + 7 hosted tests passed; zero failures; one optional promotional-capture skip. See `full-summary.json` and `full-tests.json`.
- **iPhone SE (3rd generation), 375pt, iOS 17.2:** 3 targeted journeys passed; zero failures/skips/warnings. Covers inline reply retry/cleanup, inbox filter recovery, and actual software-keyboard bounds with and without an image. See `small/small-summary.json`.
- **iPad mini (A17 Pro) / iOS 26.1:** 3 targeted journeys passed; zero failures/skips. Covers direct project switching, inline reply retry, and inbox filter recovery. See `ipad/ipad-summary.json`.
- **Final iPhone reply regression:** 3 journeys passed; zero failures/skips. Rechecks image round trip, text/image restoration after cancellation/relaunch, and rejection/retry/cleanup after the final Send-contrast and compact-attachment changes. See `final-reply/reply-summary.json`.

- **Final semantic-surface regression:** dark/large-text and note/comment journeys passed after applying the app background token to plain reading rows. See `surfaces/surfaces-summary.json`.

The shared Swift regression suite passed in every contract invocation. Focused runs repeat tests from the full suite; these are **48 successful Xcode test executions**, not 48 unique tests. There are 31 distinct UI journeys covered across these runs, including the dedicated software-keyboard check, plus 7 hosted tests.

## Screenshots to inspect

- `24-task-editor.png`, `25-task-required-subject.png`, `26-task-options.png`: required labels, compact field errors, collapsed execution options and dependent controls.
- `30-note-detail.png`, `31-note-edit.png`: document hierarchy and visible Edit.
- `navigation-sidebar-light.png`, `navigation-sidebar-dark.png`: grouped work/resources/management and pinned project/account utilities.
- `33-schedule-fields.png`: frequency-specific schedule controls.
- `35-filtered-empty.png`, `36-inbox-scope.png`: explicit scope and direct recovery.
- `small/37-reply-software-keyboard.png`, `small/38-reply-image-keyboard.png`: actual software keyboard and Send geometry. The test asserts that Send is hittable, inside the app frame and above the keyboard.
- `ipad/34-reply-retry.png`: regular-width sidebar and retained reply/image after HTTP rejection.
- `final-reply/27-reply-editor.png`, `final-reply/28-reply-keyboard.png`, `final-reply/34-reply-retry.png`: final iPhone reply layout. The filename `28-reply-keyboard` remains a historical attachment name; use the explicit small-phone screenshots to qualify the software keyboard.

Every screenshot is mapped to its producing test in `*-attachments.json`. Summaries/tests are machine-readable; fixture events and HTTP metrics are retained separately. HTTP metrics do not measure UI responsiveness.

## Reproduce

From `packages/ios`, run one contract invocation at a time; export evidence before the next invocation replaces fixture events.

```sh
make e2e-contract
make evidence RESULT=<full-passed.xcresult> EVIDENCE_OUTPUT=screenshots/usability-retest EVIDENCE_NAME=full

TEST_RUNNER_SOFTWARE_KEYBOARD=1 make e2e-contract SIMULATOR='TaskSquad Sidebar Small' SIMULATOR_OS=17.2 TEST_FLAGS='-only-testing:TaskSquadUITests/PortalFlowTests/test29InlineReplyRetainsFailedDraftAndClearsAfterSend -only-testing:TaskSquadUITests/PortalFlowTests/test30InboxScopeAndEmptyResultsCanBeCleared -only-testing:TaskSquadUITests/PortalFlowTests/test31ReplyControlsStayAboveSoftwareKeyboard'
make evidence RESULT=<small-passed.xcresult> EVIDENCE_OUTPUT=screenshots/usability-retest/small EVIDENCE_NAME=small

make e2e-contract SIMULATOR='TaskSquad Sidebar iPad' SIMULATOR_OS=26.1 TEST_FLAGS='-only-testing:TaskSquadUITests/PortalFlowTests/test27ProjectNameSwitchesWorkspaceDirectly -only-testing:TaskSquadUITests/PortalFlowTests/test29InlineReplyRetainsFailedDraftAndClearsAfterSend -only-testing:TaskSquadUITests/PortalFlowTests/test30InboxScopeAndEmptyResultsCanBeCleared'
make evidence RESULT=<ipad-passed.xcresult> EVIDENCE_OUTPUT=screenshots/usability-retest/ipad EVIDENCE_NAME=ipad

make e2e-contract TEST_FLAGS='-only-testing:TaskSquadUITests/PortalFlowTests/test05ReplyAndImageRoundTrip -only-testing:TaskSquadUITests/PortalFlowTests/test25ReplyCancellationRestoresTextDraft -only-testing:TaskSquadUITests/PortalFlowTests/test29InlineReplyRetainsFailedDraftAndClearsAfterSend'
make evidence RESULT=<reply-passed.xcresult> EVIDENCE_OUTPUT=screenshots/usability-retest/final-reply EVIDENCE_NAME=reply
```

The dedicated keyboard test skips unless `TEST_RUNNER_SOFTWARE_KEYBOARD=1` is supplied. With that flag it requires a visible software keyboard; absence is a failure, not a silent pass. The full run above was compiled before this dedicated test was added; a future default full run will also list its opt-in skip.

## Remaining diagnostics and limits

The full iOS 26.1 run recorded nine frame-dimension and four view-reparenting warnings. The iPad run recorded one of each; the final reply run's warnings are in its summary. The drawer's calculated width is clamped to zero, and explicit frame dimensions were reviewed, but the root cause of the remaining warnings is not established. Hosted tests also log duplicate Swift class loading warnings. These diagnostics have not been claimed fixed.

Manual VoiceOver traversal, accessibility-size keyboard layouts, iPad landscape keyboard behavior, realistic long datasets, offline networking and a live production account/daemon remain unqualified. No claim is made about first-time discoverability or measured completion speed. Message previews, unread/project-wide counts and global search remain limited by the current list API.

Final surface check command: `make e2e-contract TEST_FLAGS='-only-testing:TaskSquadUITests/PortalFlowTests/test17DarkAppearanceAndLargeTextRemainUsable -only-testing:TaskSquadUITests/PortalFlowTests/test13NotesCreateEditAndComment'`. Export it with `EVIDENCE_OUTPUT=screenshots/usability-retest/surfaces EVIDENCE_NAME=surfaces`.

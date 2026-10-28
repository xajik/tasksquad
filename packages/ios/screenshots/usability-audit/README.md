# Native iOS usability evidence — 2026-10-28

Baseline UI, before the proposed changes in [UX_PLAN.md](../../UX_PLAN.md).

Open [the browser report](index.html) directly in Safari or Chrome. It includes the plan, results and six embedded screenshots with enlargement controls; no server or build is required.

Existing simulator: iPhone 17 Pro / iOS 26.1, device `3D5E8AF0-85BC-4141-8E00-1A18AA2162F9`. Both runs use the disposable loopback HTTP/WebSocket fixture, production SwiftUI views and real client transports. No production tasks or agents were mutated.

- `baseline-summary.json`: 28 passed, 0 failed, 1 optional promo-capture skip. Includes 23 UI journeys and 5 hosted tests.
- `focused-summary.json`: 3 added UI journeys passed, 0 failed, 0 skipped.
- `*-tests.json`: per-test results. `*-attachments.json`: screenshot-to-test mapping and timestamps.
- `*-fixture-events.jsonl`: fixture protocol evidence. `*-macos-api-metrics.json` and `ios-api-metrics.json` concern HTTP boundaries, not UI responsiveness.

## Review these first

- [Task editor](24-task-editor.png): no required labels; secondary options visible.
- [Required-subject error](25-task-required-subject.png): bottom validation area consumes substantial writing space.
- [Task options](26-task-options.png): token level is visible with token saving off; resolved agent error remains until submit.
- [Conversation](04-conversation.png) and [large text](12-dark-large-conversation.png): header grouping and reading hierarchy.
- [Note actions](31-note-actions.png): Edit is inside overflow while comment is the floating primary action.
- [Sidebar](navigation-sidebar-light.png): project switching comes after all destinations.
- [Focused reply](28-reply-keyboard.png): text was restored after cancellation; the selected image was not. Despite its attachment name, no software keyboard is visible, so this does not prove keyboard avoidance.

## Reproduce

From `packages/ios`:

```sh
make e2e-contract
make e2e-contract TEST_FLAGS='-only-testing:TaskSquadUITests/PortalFlowTests/test24TaskRequirementsAndEditorLayout -only-testing:TaskSquadUITests/PortalFlowTests/test25ReplyCancellationRestoresTextDraft -only-testing:TaskSquadUITests/PortalFlowTests/test26NoteEditingActionLayout'
make evidence RESULT=<passed.xcresult> EVIDENCE_OUTPUT=screenshots/usability-audit EVIDENCE_NAME=baseline
```

Export each run **before** starting the next one so its fixture events and metrics are preserved. Use `EVIDENCE_NAME=focused` for the second result. The exporter rejects failed bundles.

## Limits

Seven frame-dimension warning occurrences were recorded across the two runs. Hosted tests also logged duplicate Swift class loading warnings. Assertions passed; root causes were not established. Small-phone/iPad, software-keyboard layout, VoiceOver, long realistic datasets and a live account/daemon still need qualification. These tests establish the baseline behavior; they do not measure first-time discoverability or completion speed.

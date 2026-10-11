# Shared iOS/macOS portal migration

Living tracker for unifying the iOS app (`packages/ios`) and the macOS native portal
(`packages/macos/Sources/TaskSquad/Customer*`) on this package. **Update the checklist
in the same commit as the work**, so any commit on `main` is a valid resume point.

## Goal

Both apps use one implementation for workspace behavior and reusable UI, and keep
native shells: navigation, windows, auth, pickers, keyboard handling, daemon screens.
`DESIGN.md` is authoritative. The web portal (`packages/portal`) stays the
behavioral reference through existing Worker contracts. No Worker or DB changes.

| Product | Owns |
|---|---|
| `TaskSquadPortal` | `CustomerAPI`, `WorkspaceStore`, `RecordDetailStore`, `WorkspacePolicy`, `WorkspaceEditor`, drafts, `MarkdownBlock`, terminal transport |
| `TaskSquadDesign` | `TSQTheme` tokens, `TSQButtonStyle`/`TSQLabelStyle`, Lucide/brand SVGs (`Vectors/`), generated `Assets.xcassets` |
| `TaskSquadPortalUI` | Shared SwiftUI content: `TSQBadge`, `MarkdownContent`, … |

## Resume protocol

1. `git log --oneline -- packages/mobile packages/ios packages/macos` and read the checklist below.
2. Run the gates and confirm they are green before you change anything:
   ```bash
   (cd packages/mobile/TaskSquadPortal && swift test)
   (cd packages/macos && make test && make test-compatibility && ARCHS=arm64 make app-check)
   (cd packages/ios && make build)            # make test / make e2e-contract for UI journeys
   ```
3. Pick the first unchecked item. One item per commit, and tick it in this file in that commit.

## Checklist

### A. Stabilize the in-progress work
- [x] Shared design product: `TSQTheme`, button/label styles, 60 Lucide icons and brand SVGs moved from macOS
- [x] `Theme`/`MobileTheme` reduced to typealiases; macOS UI files import `TaskSquadDesign`
- [x] Packaging ships every SwiftPM bundle (`build-app.sh`, `make preview-customer`); `check-app.sh` verifies the design bundle
- [x] Copied SVG folder renamed `Resources` → `Vectors` (an iOS flat bundle containing `Resources/` fails codesign)
- [x] `TSQResources.bundle` is a non-trapping lookup (optional) instead of `Bundle.module`
- [x] Icon digests live in `IconHashes/` (not shipped); the generator prunes imagesets whose SVG was removed
- [x] Docs and reviewed iOS screenshots restored after accidental deletion

### B. Named operations (shared mutation construction)
- [x] Fix `WorkspaceStore.mutate` scoping: key on account+project only, so section/filter changes don't drop a successful result (prevents duplicate resubmits)
- [x] Replace the global `busy` guard with per-operation dedup (`inFlight: Set<String>`), never failing silently
- [x] `WorkspaceOperation` (named constructors → path/method/body/files), `WorkspaceStore.perform(_:)`, route table tests
- [x] Migrate the macOS call sites (`CustomerWorkspace`, `CustomerTaskDetail`, `CustomerNoteDetail`, `ApplicationWorkspace`)
- [ ] Migrate the iOS call sites (`MobileRecordDetail`, `PortalHomeView`); remove the app-level `perform(path:method:)`
- [ ] macOS editors use `WorkspaceDraftStore`/`WorkspaceDraftScope`; delete iOS `MobileDraftStore`
- [ ] Tests: `WorkspaceEditor` validation, `StatusPresentation`, draft-scope isolation

### C. Store completion
- [ ] Single poll driver per shell; coalesce overlapping refreshes; the macOS notification monitor reuses inbox records instead of a second `/tasks` poll
- [ ] Remove the iOS detail-screen poll loop (`MobileRecordDetail` `.task`) in favor of a chained detail refresh
- [ ] `CustomerWorkspaceModel`: delete duplicated `path(for:)`, `teamPath`, `agentName`, `isOwner`, `isPro`, `currentTeam`
- [ ] `RecordDetailStore`: concurrent note comments/tasks; Portal lifecycle state
- [ ] Tests: pagination survives refresh, out-of-order detail, account switch during `connect`, poll cancellation

### D. Shared content components
- [ ] Move `Card`, `EmptyState`, `ErrorBanner`, `StatusDot`, `PageHeader` to `TaskSquadPortalUI`
- [ ] `RecordRow`, `ConversationMessage` + authenticated attachments, `PhaseSummary`, `MetricTile`, `TerminalConnectionHeader`
- [ ] `MarkdownContent`: tokens instead of `accentColor`/`.quaternary`; move `MarkdownBlock.parse` tests into this package
- [ ] `TaskSquadPortalUI` render smoke tests

### E. Remove compatibility layers
- [ ] iOS uses `CustomerAPI` directly; delete `PortalAPI`
- [ ] Drop the `Theme`/`MobileTheme`/`MobilePrimaryButtonStyle` typealiases (optional, mechanical)

### F. CI and evidence
- [ ] `macos-native.yml` triggers on `packages/mobile/**`; add a `swift test` job for this package
- [ ] iOS CI job: explicit simulator/runtime resolution, recorded in the summary, fails if none is available
- [ ] Regenerate reviewed light/dark screenshots on both platforms from the fixture

## Notes and decisions
- Task removal: macOS offers **Delete** (`DELETE /tasks/:id`, as on the web) and iOS offers **Cancel** (`PUT /tasks/:id {status: cancelled}`). Both are valid Worker routes (`.deleteTask`, `.cancelTask`). Choosing one UX for both apps is still open.
- `createPayload` drops `scheduled_at: null` and empty `close_steps`, as macOS did before, for both apps.
- Icon sources: `scripts/vendor-icons.mjs` (macOS) writes `Sources/TaskSquadDesign/Vectors/Icons`. `packages/ios/scripts/generate_icons.swift` (run by `make build` in `packages/ios`) regenerates PDF imagesets when a source digest changes.
- The macOS tray icon (`Brand/tray.svg`) stays in the app bundle (`TaskSquad_TaskSquad.bundle`), since it is platform-specific.

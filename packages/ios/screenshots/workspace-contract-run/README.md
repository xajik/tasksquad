# iOS workspace qualification — 2026-10-11

The installed, ad hoc signed iPhone 17 Pro simulator app ran against a disposable loopback HTTP/WebSocket service. The production SwiftUI screens, customer clients, browser authentication, Keychain and SwiftTerm transport were exercised. No in-app demo terminal was used. No production records or daemon sessions were created.

## Fixes and regression coverage

| Review issue | Change | Evidence |
| --- | --- | --- |
| Terminal-only app | Shared customer client, section/field schemas, full workspace navigation and native editors/details | UI 01–06, 13–15; Mac customer workspace regressions |
| Clipped/legacy-sized app | Launch metadata, native navigation/editors, keyboard dismissal, Dynamic Type and appearance | UI 01, 08, 17; hosted bundle test; reviewed screenshots |
| Demo-only success | Test-owned stateful HTTP/WS fixture, independently observed mutations/input, browser PKCE | Named UI results and sanitized fixture events |
| Pending Portal never becomes terminal | Poll Portal detail until running/session ID; real relay; stop on completion | UI 07–12 |
| Empty project dead end/stale responses | Always-present project picker; clear old scope; reject late requests | UI 01–02; shared store regression |
| Hidden failures/duplicate mutations | Busy gates, persistent editor/detail error banners, retry retaining draft | UI 06, 11; shared mutation regression |
| Wrong close/history contract | Cancel means no mutation; close retains completed server record | UI 10–12; Mac retained-history regression |
| Credential expiry/missing metadata | Origin-scoped expiring Keychain credentials, stale callback cancellation, simulator signing/entitlements | Four hosted auth/bundle tests; UI 16 |
| Invalid performance comparison | Identical Portal HTTP workflow and transport on both platforms | 15 samples each in JSON; no UI speed claim |

The full Xcode acceptance run passed **22 tests: 17 UI journeys and 5 hosted tests**, with no failures or skips. Shared package checks separately passed 3 XCTest tests and 2 Swift Testing protocol tests. The macOS Go-reference compatibility run passed **91 tests, one skipped, no failures**. Mac tests include actual tmux compatibility and native UI/model regression coverage; their mocked model durations are not compared with iOS UI durations.

Two focused image journeys were rerun after strengthening the fixture to return the exact uploaded bytes. Both passed, asserting PNG signature/size, SHA-256 equality and native image rendering. The landscape journey was rerun after rejecting Xcode’s app-scoped capture, which retained a portrait canvas after rotation. The follow-up asserts landscape layout and screen-capture dimensions. See the focused summaries and attachment manifests; their screenshots supersede the matching full-run screenshots.

## Screenshots

- `00-sign-in.png`: native browser-auth entry.
- `01-empty-project.png`, `02-inbox.png`: complete portrait layout and usable project picker.
- `03-created-task.png`, `04-conversation.png`, `13-reply-image.png`: Unicode messages and actual uploaded image.
- `05-live-terminal.png`, `06-terminal-landscape.png`: real fixture WebSocket output and terminal controls.
- `07-portal-history.png`, `08-note.png`, `09-settings.png`: retained history and customer workspace.
- `10-authenticated-workspace.png`: workspace reached through browser PKCE.
- `11-dark-large-inbox.png`, `12-dark-large-conversation.png`: accessibility text size in dark mode; lists remain scrollable.

## Matching API timings

Same host, loopback fixture, native `PortalAPI` and URLSession. Each of 15 samples lists Portals, creates one, gets its pending detail, closes it and lists retained history. Median milliseconds:

| Operation | macOS | iOS simulator |
| --- | ---: | ---: |
| List | 0.33 | 0.68 |
| Create | 0.40 | 0.82 |
| Get pending detail | 0.31 | 0.59 |
| Close and list history | 0.73 | 1.47 |
| Complete workflow | 1.75 | 3.52 |

`performance-comparison.json` contains ranges and medians; raw samples are retained. These numbers measure local HTTP/client work, not UI rendering, production latency, provider execution or terminal throughput. The sub-millisecond difference is not a production performance qualification.

## Reproduce and interpret

From `packages/ios`, run `make e2e-contract DERIVED_DATA=.build/Qualification`. Export the resulting passed xcresult with `make evidence RESULT=<path>`. The harness refuses an occupied fixture port and stops only its own service. Events omit authorization headers, reusable credentials and PKCE secrets.

`full-summary.json`/`full-tests.json` are the complete acceptance result. Focused result files record strengthened follow-ups. `screenshots.json` identifies the final screenshot’s test, run, capture timestamp and SHA-256; focused captures supersede the originals. The JSONL journals contain server-side observations of the native requests and terminal frames.

This qualifies the simulator/client fixes. It does **not** qualify live production authentication, all advanced web workflows, daemon/provider execution, device installation, APNs, Watch, or Store distribution. Those remain separate delivery/qualification work; opening every workspace section is not proof that every production operation completed.

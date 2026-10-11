# TaskSquad for iPhone and iPad

Native SwiftUI customer workspace for existing TaskSquad accounts. The app has Inbox/task conversations, task creation/replies/images/scheduling, remote Portals, notes/comments, conveyors, planners, resource libraries, memory, analytics, agents, members, and project settings. Account eligibility and project roles govern management controls; the app contains no purchase or upgrade links.

The macOS app and iOS app share the customer HTTP client, JSON records, section definitions, editor field definitions, and Portal terminal transport through `packages/mobile/TaskSquadPortal`. Local execution and the daemon remain macOS/Linux responsibilities.

## Build and run

Requires Xcode, XcodeGen, Python 3 with venv, and the selected simulator runtime.

```sh
make build
make e2e-contract DERIVED_DATA=.build/Qualification
```

Override `SIMULATOR` and `SIMULATOR_OS` for another installed device/runtime. Simulator builds use local ad hoc signing and explicit Keychain entitlements. Disabling signing breaks Keychain and is not an authentication qualification build. Device distribution requires the developer's normal signing/provisioning configuration.

`make e2e-contract` owns a disposable loopback HTTP/WebSocket server on port 18743, runs shared regression tests and a matching macOS HTTP baseline, then runs hosted iOS unit tests and simulator UI tests. It shuts down only the server it started. Python dependencies are pinned in `scripts/requirements.txt` and installed into `.build/fixture-env`. The runner refuses to reuse an occupied fixture port.

`TEST_FLAGS` may select individual Xcode tests while repairing a regression. The acceptance run executes the complete suite. Export named screenshots and results with `make evidence RESULT=<passed.xcresult-path>`; the exporter refuses failed bundles.

## Authentication and isolation

Browser authentication uses ASWebAuthenticationSession, a registered callback scheme, a cryptographically random PKCE verifier and state, and a single-use code exchange. Only the resulting credential is stored in Keychain, scoped to API origin with its expiration. Expired/rejected credentials return to sign-in. Logout cancels sign-in callbacks, deletes local credentials/drafts, and attempts remote revocation.

Project responses are guarded by context and request generations. A project change clears previous project data immediately; an older response cannot overwrite the new project. Project selection remains available when a project is empty. Draft keys include the account and project.

Debug fixture entry points accept only loopback URLs and are compiled out of release builds. Fixture drafts use a separate defaults suite. `--ui-test-api` supplies a disposable server credential; `--ui-test-auth` exercises browser PKCE and Keychain with a disposable local account. Neither is production authentication qualification.

## Evidence and limits

Current evidence belongs in `screenshots/workspace-contract-run`: native screenshots, named test results, sanitized fixture events, and timings with identical HTTP boundaries. HTTP timings measure networking/client work, not native UI speed. The macOS rendering/model suite provides separate regression coverage.

A successful fixture run qualifies simulator layout, client flows and protocols. A live production account/daemon run, device signing and installation, real provider behavior, APNs delivery, and Store distribution require separate qualification. No fixture test claims these occurred.

## Native design

The app uses the light/dark color tokens, six-point control radius and Lucide assets from the root `DESIGN.md`. `make icons` converts the macOS SVG sources into iOS PDF template assets and the existing brand into an app icon. Native navigation, menus, form controls, SF symbols within system-provided controls, and Dynamic Type spacing remain platform conventions. These deliberate deviations preserve keyboard behavior, accessibility and 44-point touch targets rather than imposing web sizing.

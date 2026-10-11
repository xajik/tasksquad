# iOS sidebar navigation

The iOS shell now uses a slide-over sidebar in compact width and a native split sidebar in regular width. Projects and Account are full navigation destinations. Project settings remain scoped to the selected project. Inbox filters live in a sheet; the content list no longer contains project or section pickers.

All evidence uses the production SwiftUI views and a disposable local HTTP/WebSocket fixture. The test devices are dedicated simulators so another build cannot replace the application mid-run.

## Behavior covered

- Destination selection and grouped Skills / Sub-agents / Commands navigation.
- Closing the drawer preserves the open detail; Account Back restores it.
- Switching projects from a detail clears the old selection and records.
- Project search, request failures and retry, zero projects, and member permissions.
- Existing create/reply/attachment, terminal, browser authentication and sign-out contracts.
- Light/dark phone and tablet layouts and accessibility-size phone text.

## Reproduce

From `packages/ios`, use an available dedicated simulator:

```sh
make build SIMULATOR='TaskSquad Sidebar Review'
make e2e-contract SIMULATOR='TaskSquad Sidebar Review'
make e2e-contract SIMULATOR='TaskSquad Sidebar Small' SIMULATOR_OS=17.2 TEST_FLAGS='-only-testing:TaskSquadUITests/PortalFlowTests/test17DarkAppearanceAndLargeTextRemainUsable -only-testing:TaskSquadUITests/PortalFlowTests/test19NavigationScreenshots'
make e2e-contract SIMULATOR='TaskSquad Sidebar iPad' TEST_FLAGS='-only-testing:TaskSquadUITests/PortalFlowTests/test19NavigationScreenshots'
```

Export successful result bundles with `scripts/export_evidence.py --output screenshots/sidebar-navigation/<device>`. Named navigation screenshots are exported alongside the test summary and fixture evidence.

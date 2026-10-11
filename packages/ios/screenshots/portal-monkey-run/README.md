# Portal simulator monkey run

Run on 2026-10-11 with the iPhone 17 Pro simulator (iOS 26.1). A seeded state-aware runner (`0x51C0FFEE`) performed 15 fresh app launches. Each pass opened the demo Portal, performed five randomized reconnect or back-and-reopen actions, then confirmed close and checked the empty state. All 15 passes passed in 451.5 seconds.

| Measurement | iOS simulator mean | iOS simulator median | macOS fixture mean |
| --- | ---: | ---: | ---: |
| Launch to Portal list | 2,941 ms | 2,923 ms | 0.78 ms to restore and load list |
| Open Portal detail/terminal | 2,210 ms | 2,215 ms | 0.30 ms to load selected detail |
| Confirm close | 3,920 ms | 3,916 ms | 0.26 ms to submit close and refresh |

The iOS timings include simulator app launch, UI automation, and state assertions. The macOS measurements use an in-process fixture transport and time model/API work; they do not include launching the Mac app or a network request. These numbers show the local fixture overhead on each platform and are not a like-for-like speed comparison.

The tested behavior covers Portal list, terminal/detail open, reconnect, back/reopen, confirmed close, and return to the empty state. Both runs use demo/mock data: no account, live Portal, terminal WebSocket, or production API was exercised. The iOS screenshot displays the demo terminal; the macOS screenshot is a SwiftUI render from the native customer workspace test.

Artifacts:

- `portal-home.png` and `portal-terminal.png`: iOS simulator screenshots.
- `macos-native-detail.png`: macOS native workspace render.
- `metrics.json`: per-iteration iOS timings and action traces.
- `macos-metrics.json`: per-iteration macOS fixture timings and action traces.
- `manifest.json`: Xcode result-bundle attachment metadata.

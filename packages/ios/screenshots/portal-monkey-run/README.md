# Rejected prototype qualification evidence

These screenshots and timings were reviewed and **failed acceptance**: the iOS layout is clipped, the terminal is static demo text, and the closing behavior contradicts the server. A green repeated demo test does not establish E2E functionality or parity.

The historical iOS measurements include simulator launch and UI automation. The macOS figures measure mocked model operations. They have different boundaries and must not be compared as app performance.

The original run performed 15 repeats of one demo journey, not 15 distinct E2E scenarios. It exercised no authentication, HTTP API, terminal WebSocket, or production account. Preserve these files as evidence of the prototype defects. Current verification belongs in `../workspace-contract-run/`.

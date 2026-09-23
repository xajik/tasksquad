Native Swift macOS development preview. Requires macOS 13 or later; includes Apple Silicon and Intel binaries.

This build displays configured agents and sessions, supports sign-in, inspects existing logs/task journals, and edits the existing TOML configuration. The embedded engine currently supports explicitly configured `stdout` providers, including task polling, native processes, session completion and encrypted log uploads. Interactive provider integrations, complete session controls, background services and the full `tsq` CLI are still being implemented. This is not a replacement for the running Go daemon yet.

Install as **TaskSquad Native.app**. Go remains the Linux implementation and the reference for compatibility. Existing configuration changes affect both implementations.

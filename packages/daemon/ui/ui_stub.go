//go:build !cgo || !darwin

package ui

// Run blocks the main OS thread. No system tray is shown on this platform
// (CGO disabled or non-Darwin OS). Agents continue running in goroutines.
// A wakelock is acquired to prevent idle sleep while pulling is active.
func Run(_ []AgentStatus, _ PullController, _ string) {
	wl := acquireWakelock()
	defer wl.Release()
	select {}
}

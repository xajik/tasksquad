//go:build !cgo || !darwin

package ui

// AgentStatus is the interface main passes to expose per-agent state.
type AgentStatus interface {
	Name() string
	GetMode() string
}

// Run blocks the main OS thread. No system tray is shown on this platform
// (CGO disabled or non-Darwin OS). Agents continue running in goroutines.
func Run(_ []AgentStatus, _ string) {
	select {}
}

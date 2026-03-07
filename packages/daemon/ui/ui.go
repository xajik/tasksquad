// Package ui implements the system tray / menubar icon for the tsq daemon.
//
// TODO: Implement using github.com/getlantern/systray (cross-platform).
//
// Required platform dependencies:
//
//	macOS:   Xcode command line tools (CGo)
//	Linux:   libappindicator3-dev, libgtk-3-dev
//	Windows: no extra deps
//
// Planned menu layout:
//
//	[TSQ icon]
//	├── ● 0 running           ← live count, updates every 5s
//	├── ─────────────────────
//	├── my-agent: idle        ← one item per agent
//	├── ─────────────────────
//	├── Open Dashboard        ← opens browser to dashboardURL
//	├── ─────────────────────
//	└── Quit
//
// Implementation notes:
//   - systray.Run() MUST be called on the main OS thread (macOS AppKit requirement).
//   - All agent work stays in goroutines; ui.Run blocks the caller.
//   - Icon: 22×22 monochrome PNG, embedded via //go:embed icon.png.
package ui

import "github.com/tasksquad/daemon/logger"

// AgentStatus is the interface main passes to expose per-agent state.
type AgentStatus interface {
	// Name returns the agent's display name from config.
	Name() string
	// GetMode returns the current mode string: "idle" | "running" | "waiting_input".
	GetMode() string
}

// Run starts the system tray UI. It is intended to block on the main OS thread.
//
// Currently a no-op stub — see package-level TODO for the full implementation plan.
func Run(agents []AgentStatus, dashboardURL string) {
	logger.Info("[ui] Systray UI not yet implemented — running headless")
	// TODO: uncomment once github.com/getlantern/systray is added to go.mod:
	//
	// systray.Run(
	//   func() { onReady(agents, dashboardURL) },
	//   func() { os.Exit(0) },
	// )
}

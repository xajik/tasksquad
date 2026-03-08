// Package ui implements the system tray / menubar icon for the tsq daemon.
//
// Uses github.com/getlantern/systray (cross-platform, CGo required).
//
// Required platform dependencies:
//
//	macOS:   Xcode command line tools (CGo + Cocoa framework, auto-linked)
//	Linux:   libappindicator3-dev, libgtk-3-dev
//	Windows: no extra deps
//
// Menu layout (mirrors prototype/tasksquad-demo.html):
//
//	tsq                           ← menu bar title (text, no icon needed)
//	├── ● TaskSquad v0.1.0        ← header, disabled
//	├── N running · N idle · N waiting  ← live stats, disabled, refreshed every 5s
//	├── ─────────────────────────
//	├── Open Dashboard            ← opens browser to dashboardURL
//	├── ─────────────────────────
//	├── ── Agents ──              ← section label, disabled
//	├──   ● agent-name: running   ← one per agent, disabled, refreshed every 5s
//	├── ─────────────────────────
//	└── Quit
package ui

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/getlantern/systray"
	"github.com/tasksquad/daemon/logger"
)

//go:embed systray.png
var iconData []byte

const uiVersion = "0.1.0"

// AgentStatus is the interface main passes to expose per-agent state.
type AgentStatus interface {
	// Name returns the agent's display name from config.
	Name() string
	// GetMode returns the current mode string: "idle" | "running" | "waiting_input".
	GetMode() string
}

// Run starts the system tray UI on the main OS thread (required by macOS AppKit).
// It blocks until the user clicks Quit or the process is killed.
func Run(agents []AgentStatus, dashboardURL string) {
	systray.Run(
		func() { onReady(agents, dashboardURL) },
		func() { os.Exit(0) },
	)
}

func onReady(agents []AgentStatus, dashboardURL string) {
	systray.SetIcon(iconData)
	systray.SetTitle("")
	systray.SetTooltip("TaskSquad Daemon " + uiVersion)

	// ── Header (disabled) ──────────────────────────────────────────────────
	mHeader := systray.AddMenuItem("● TaskSquad "+uiVersion, "TaskSquad daemon")
	mHeader.Disable()

	mStats := systray.AddMenuItem(statsLabel(agents), "Live agent status")
	mStats.Disable()

	systray.AddSeparator()

	// ── Quick actions ──────────────────────────────────────────────────────
	mDash := systray.AddMenuItem("Open Dashboard", dashboardURL)

	systray.AddSeparator()

	// ── Per-agent rows (disabled, status-only) ─────────────────────────────
	mAgentsLabel := systray.AddMenuItem("── Agents ──", "")
	mAgentsLabel.Disable()

	agentItems := make([]*systray.MenuItem, len(agents))
	for i, a := range agents {
		agentItems[i] = systray.AddMenuItem(agentLabel(a), "")
		agentItems[i].Disable()
	}

	systray.AddSeparator()

	mQuit := systray.AddMenuItem("Quit", "Stop the tsq daemon")

	// ── Click handlers ─────────────────────────────────────────────────────
	go func() {
		for range mDash.ClickedCh {
			openBrowser(dashboardURL)
		}
	}()
	go func() {
		for range mQuit.ClickedCh {
			logger.Info("[ui] Quit selected — stopping daemon")
			systray.Quit()
		}
	}()

	// ── Live refresh every 5s ──────────────────────────────────────────────
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			label := statsLabel(agents)
			mStats.SetTitle(label)
			systray.SetTooltip(fmt.Sprintf("TaskSquad — %s", label))
			for i, a := range agents {
				agentItems[i].SetTitle(agentLabel(a))
			}
		}
	}()

	logger.Info("[ui] Systray ready")
}

// statsLabel returns a summary string like "2 running · 1 idle · 0 waiting".
func statsLabel(agents []AgentStatus) string {
	running, idle, waiting := 0, 0, 0
	for _, a := range agents {
		switch a.GetMode() {
		case "running":
			running++
		case "idle":
			idle++
		case "waiting_input":
			waiting++
		}
	}
	return fmt.Sprintf("%d running · %d idle · %d waiting", running, idle, waiting)
}

// agentLabel formats a single agent row with a unicode status dot.
//
//	● running   ◐ waiting_input   ○ idle
func agentLabel(a AgentStatus) string {
	dot := map[string]string{
		"running":       "●",
		"waiting_input": "◐",
		"idle":          "○",
	}[a.GetMode()]
	if dot == "" {
		dot = "○"
	}
	return fmt.Sprintf("  %s %s: %s", dot, a.Name(), a.GetMode())
}

// openBrowser opens url in the default system browser.
func openBrowser(url string) {
	var cmd string
	switch runtime.GOOS {
	case "darwin":
		cmd = "open"
	case "linux":
		cmd = "xdg-open"
	default:
		logger.Warn("[ui] openBrowser: unsupported OS")
		return
	}
	if err := exec.Command(cmd, url).Start(); err != nil {
		logger.Warn(fmt.Sprintf("[ui] Failed to open browser: %v", err))
	}
}

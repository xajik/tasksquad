//go:build cgo && darwin

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
// Menu layout:
//
//	tsq                               ← menu bar title
//	├── ● TaskSquad v0.1.0            ← header, disabled
//	├── N running · N idle · N waiting ← live stats, refreshed every 5s
//	├── ─────────────────────────
//	├── ⏸ Pause Pulling               ← toggle; label flips to ▶ Resume Pulling
//	├── Open Dashboard                ← opens browser to dashboardURL
//	├── ─────────────────────────
//	├── ── Agents ──                  ← section label, disabled
//	├── 📁 ~/Projects/myapp           ← folder group header, disabled
//	├──   ● agent-name: running       ← one per agent, refreshed every 5s
//	├── ─────────────────────────
//	└── Quit
//
// Icon: green circle = pulling active, red circle = paused.
package ui

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/getlantern/systray"
	"github.com/tasksquad/daemon/logger"
)

//go:embed systray-on.png
var iconActiveData []byte

//go:embed systray-off.png
var iconPausedData []byte

// Run starts the system tray UI on the main OS thread (required by macOS AppKit).
// It blocks until the user clicks Quit or the process is killed.
func Run(agents []AgentStatus, ctrl PullController, authCtrl AuthController, autostartCtrl AutostartController, dashboardURL string, configPath string, version string) {
	systray.Run(
		func() { onReady(agents, ctrl, authCtrl, autostartCtrl, dashboardURL, configPath, version) },
		func() { os.Exit(0) },
	)
}

func onReady(agents []AgentStatus, ctrl PullController, authCtrl AuthController, autostartCtrl AutostartController, dashboardURL string, configPath string, version string) {
	// Green icon = pulling active; red icon = paused.
	if ctrl.IsPaused() {
		systray.SetIcon(iconPaused())
	} else {
		systray.SetIcon(iconActive())
	}
	systray.SetTitle("")
	systray.SetTooltip("TaskSquad Daemon " + version)

	// ── Header (disabled) ──────────────────────────────────────────────────
	mHeader := systray.AddMenuItem("● TaskSquad "+version, "TaskSquad daemon")
	mHeader.Disable()

	// Auth status row — shows logged-in email.
	mAuth := systray.AddMenuItem(authLabel(authCtrl.Email()), "Logged-in user")
	mAuth.Disable()

	mStats := systray.AddMenuItem(statsLabel(agents), "Live agent status")
	mStats.Disable()

	systray.AddSeparator()

	// ── Auth actions ───────────────────────────────────────────────────────
	mLogout := systray.AddMenuItem("Logout", "Log out and stop the daemon")

	systray.AddSeparator()

	// ── Pull toggle ────────────────────────────────────────────────────────
	mToggle := systray.AddMenuItem(pullToggleLabel(ctrl.IsPaused()), "Toggle task pulling")

	// ── Quick actions ──────────────────────────────────────────────────────
	mDash := systray.AddMenuItem("Open Web Portal", dashboardURL)
	mSessions := systray.AddMenuItem("Control Panel", "Open control panel")
	mBoot := systray.AddMenuItem(bootLabel(autostartCtrl.IsEnabled()), "Toggle run on OS boot")

	systray.AddSeparator()

	// ── Per-agent rows grouped by workDir ─────────────────────────────────
	mAgentsLabel := systray.AddMenuItem("── Agents ──", "")
	mAgentsLabel.Disable()

	// Build ordered groups: map workDir → agent indices (preserving insertion order)
	type agentGroup struct {
		dir     string
		indices []int
	}
	var groups []agentGroup
	dirIdx := map[string]int{}
	for i, a := range agents {
		dir := a.WorkDir()
		if dir == "" {
			dir = "(unknown)"
		}
		if gi, ok := dirIdx[dir]; ok {
			groups[gi].indices = append(groups[gi].indices, i)
		} else {
			dirIdx[dir] = len(groups)
			groups = append(groups, agentGroup{dir: dir, indices: []int{i}})
		}
	}

	agentItems := make([]*systray.MenuItem, len(agents))
	for _, g := range groups {
		hdr := systray.AddMenuItem(folderLabel(g.dir), g.dir)
		hdr.Disable()
		for _, i := range g.indices {
			agentItems[i] = systray.AddMenuItem(agentLabel(agents[i]), agents[i].LastLogPath())
		}
	}

	systray.AddSeparator()

	mConfig := systray.AddMenuItem("Open Config", "Edit config.toml")
	mQuit := systray.AddMenuItem("Quit", "Stop the tsq daemon")

	// ── Start local control panel server ──────────────────────────────────
	cpURL := StartDashboard(agents, authCtrl.Email(), dashboardURL, configPath)
	if cpURL != "" {
		mSessions.SetTooltip(cpURL)
	} else {
		mSessions.Disable()
	}

	// ── Acquire wakelock if pulling is active at startup ───────────────────
	var wl *wakelock
	if !ctrl.IsPaused() {
		wl = acquireWakelock()
	}

	// ── Toggle click handler ───────────────────────────────────────────────
	go func() {
		for range mToggle.ClickedCh {
			if ctrl.IsPaused() {
				ctrl.Resume()
				wl = acquireWakelock()
				systray.SetIcon(iconActive())
				mToggle.SetTitle(pullToggleLabel(false))
				logger.Info("[ui] Pulling resumed")
			} else {
				ctrl.Pause()
				if wl != nil {
					wl.Release()
					wl = nil
				}
				systray.SetIcon(iconPaused())
				mToggle.SetTitle(pullToggleLabel(true))
				logger.Info("[ui] Pulling paused")
			}
		}
	}()

	go func() {
		for range mLogout.ClickedCh {
			logger.Info("[ui] Logout selected — clearing credentials and stopping daemon")
			if err := authCtrl.Logout(); err != nil {
				logger.Warn(fmt.Sprintf("[ui] Logout error: %v", err))
			}
			systray.Quit()
		}
	}()

	go func() {
		for range mDash.ClickedCh {
			if authCtrl.Email() != "" {
				openBrowser(dashboardURL + "/dashboard")
			} else {
				openBrowser(dashboardURL + "/auth")
			}
		}
	}()
	go func() {
		for range mSessions.ClickedCh {
			if cpURL != "" {
				openBrowser(cpURL)
			}
		}
	}()
	go func() {
		for range mBoot.ClickedCh {
			if autostartCtrl.IsEnabled() {
				if err := autostartCtrl.Disable(); err != nil {
					logger.Warn(fmt.Sprintf("[ui] autostart disable: %v", err))
				} else {
					mBoot.SetTitle(bootLabel(false))
					logger.Info("[ui] Run on OS boot disabled")
				}
			} else {
				if err := autostartCtrl.Enable(); err != nil {
					logger.Warn(fmt.Sprintf("[ui] autostart enable: %v", err))
				} else {
					mBoot.SetTitle(bootLabel(true))
					logger.Info("[ui] Run on OS boot enabled")
				}
			}
		}
	}()
	go func() {
		for range mConfig.ClickedCh {
			openBrowser(configPath)
		}
	}()
	go func() {
		for range mQuit.ClickedCh {
			logger.Info("[ui] Quit selected — stopping daemon")
			systray.Quit()
		}
	}()

	// ── Per-agent click handlers ───────────────────────────────────────────
	for i, a := range agents {
		i, a := i, a
		go func() {
			for range agentItems[i].ClickedCh {
				if sess := a.TmuxSession(); sess != "" {
					attachTmux(sess)
				} else if logPath := a.LastLogPath(); logPath != "" {
					openBrowser(logPath)
				}
			}
		}()
	}

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

func bootLabel(enabled bool) string {
	if enabled {
		return "✓ Run on OS Boot"
	}
	return "  Run on OS Boot"
}

func pullToggleLabel(paused bool) string {
	if paused {
		return "▶ Resume Pulling"
	}
	return "⏸ Pause Pulling"
}

// statsLabel returns a summary string like "2 running · 1 idle · 0 waiting · Last pull: 2m ago".
func statsLabel(agents []AgentStatus) string {
	running, idle, waiting := 0, 0, 0
	var lastPull time.Time
	for _, a := range agents {
		switch a.GetMode() {
		case "running":
			running++
		case "idle":
			idle++
		case "waiting_input":
			waiting++
		}
		if t := a.LastPullTime(); !t.IsZero() && t.After(lastPull) {
			lastPull = t
		}
	}
	return fmt.Sprintf("%d running · %d idle · %d waiting · Last pull: %s",
		running, idle, waiting, relTime(lastPull))
}

// relTime formats a time as a human-readable relative duration ("5s ago", "3m ago", "never").
func relTime(t time.Time) string {
	if t.IsZero() {
		return "never"
	}
	d := time.Since(t).Round(time.Second)
	if d < time.Minute {
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	}
	return fmt.Sprintf("%dm ago", int(d.Minutes()))
}

// attachTmux opens a terminal window and attaches to the given tmux session.
func attachTmux(session string) {
	switch runtime.GOOS {
	case "darwin":
		script := fmt.Sprintf(`tell application "Terminal" to do script "tmux attach-session -t %s"`, session)
		exec.Command("osascript", "-e", script).Start() //nolint:errcheck
	case "linux":
		exec.Command("x-terminal-emulator", "-e", "tmux", "attach-session", "-t", session).Start() //nolint:errcheck
	default:
		logger.Warn("[ui] attachTmux: unsupported OS")
	}
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

// folderLabel formats a workDir path for display as a group header.
// Replaces the home directory with ~, e.g. "/Users/alice/Projects/app" → "📁 ~/Projects/app".
func folderLabel(dir string) string {
	if home, err := os.UserHomeDir(); err == nil {
		if rel, err := filepath.Rel(home, dir); err == nil && !filepath.IsAbs(rel) {
			dir = "~/" + rel
		}
	}
	return "📁 " + dir
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

// authLabel formats the auth status row for the menu.
func authLabel(email string) string {
	if email == "" {
		return "👤 Not logged in"
	}
	return "👤 " + email
}

// iconActive returns the embedded systray-on.png icon (pulling active).
func iconActive() []byte { return iconActiveData }

// iconPaused returns the embedded systray-off.png icon (pulling paused).
func iconPaused() []byte { return iconPausedData }

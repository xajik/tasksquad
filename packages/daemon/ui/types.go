package ui

import "time"

// AgentStatus is the interface main passes to expose per-agent state.
type AgentStatus interface {
	// Name returns the agent's display name from config.
	Name() string
	// GetMode returns the current mode string: "idle" | "running" | "waiting_input".
	GetMode() string
	// LastPullTime returns the time of the last successful heartbeat, or zero time if none yet.
	LastPullTime() time.Time
	// LastLogPath returns the path to the current per-task run log file, or "" if none.
	LastLogPath() string
	// TmuxSession returns the active tmux session name, or "" if not running in tmux.
	TmuxSession() string
	// GetTaskID returns the current task ID being executed, or "" if idle.
	GetTaskID() string
}

// PullController lets the UI pause and resume all agents' heartbeat polling.
type PullController interface {
	Pause()
	Resume()
	IsPaused() bool
}

// AuthController lets the UI display auth status and trigger logout.
type AuthController interface {
	// Email returns the currently logged-in user's email, or "" if not logged in.
	Email() string
	// Logout removes stored credentials and exits so the user can re-login.
	Logout() error
}

// AutostartController manages OS-boot registration for the daemon.
type AutostartController interface {
	// IsEnabled returns true if the daemon is registered to start on OS boot.
	IsEnabled() bool
	// Enable registers the daemon to start on OS boot.
	Enable() error
	// Disable removes the daemon's OS-boot registration.
	Disable() error
}

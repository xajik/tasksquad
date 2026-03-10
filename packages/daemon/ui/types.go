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
}

// PullController lets the UI pause and resume all agents' heartbeat polling.
type PullController interface {
	Pause()
	Resume()
	IsPaused() bool
}

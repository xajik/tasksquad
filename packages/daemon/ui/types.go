package ui

// AgentStatus is the interface main passes to expose per-agent state.
type AgentStatus interface {
	// Name returns the agent's display name from config.
	Name() string
	// GetMode returns the current mode string: "idle" | "running" | "waiting_input".
	GetMode() string
}

// PullController lets the UI pause and resume all agents' heartbeat polling.
type PullController interface {
	Pause()
	Resume()
	IsPaused() bool
}

// Package agentmode defines the agent lifecycle mode type and task completion
// status constants. It is a leaf package (no daemon imports) so both the agent
// and hooks packages can import it without creating a cycle.
package agentmode

// Mode represents the lifecycle state of an agent.
type Mode string

const (
	ModeIdle         Mode = "idle"
	ModeRunning      Mode = "running"
	ModeWaitingInput Mode = "waiting_input"
	ModeLearning     Mode = "learning"
)

// CompletionStatus is the terminal outcome of a task session.
type CompletionStatus string

const (
	StatusClosed    CompletionStatus = "closed"
	StatusCrashed   CompletionStatus = "crashed"
	StatusCancelled CompletionStatus = "cancelled"
)

// Package agentmode defines the agent lifecycle mode type and all status
// constants used across the daemon. It is a leaf package (no daemon imports)
// so both the agent and hooks packages can import it without creating a cycle.
package agentmode

// Mode represents the lifecycle state of an agent.
type Mode string

const (
	ModeIdle         Mode = "idle"
	ModeRunning      Mode = "running"
	ModeWaitingInput Mode = "waiting_input"
	ModeLearning     Mode = "wrapping_up"
)

// CompletionStatus is the terminal outcome of a task session.
type CompletionStatus string

const (
	StatusClosed    CompletionStatus = "closed"
	StatusCrashed   CompletionStatus = "crashed"
	StatusCancelled CompletionStatus = "cancelled"
)

// TaskStatus is the lifecycle state of a task as stored on the server.
type TaskStatus string

const (
	TaskStatusPending      TaskStatus = "pending"
	TaskStatusRunning      TaskStatus = "running"
	TaskStatusWaitingInput TaskStatus = "waiting_input"
	TaskStatusWrappingUp   TaskStatus = "wrapping_up"
	TaskStatusDone         TaskStatus = "done"
	TaskStatusFailed       TaskStatus = "failed"
	TaskStatusScheduled    TaskStatus = "scheduled"
	TaskStatusCancelled    TaskStatus = "cancelled"
)

// AgentServerStatus is the agent status as reported to and from the server.
type AgentServerStatus string

const (
	AgentServerStatusOffline      AgentServerStatus = "offline"
	AgentServerStatusIdle         AgentServerStatus = "idle"
	AgentServerStatusRunning      AgentServerStatus = "running"
	AgentServerStatusWaitingInput AgentServerStatus = "waiting_input"
	AgentServerStatusWrappingUp   AgentServerStatus = "wrapping_up"
)

// SessionStatus is the lifecycle state of a session as stored on the server.
type SessionStatus string

const (
	SessionStatusRunning      SessionStatus = "running"
	SessionStatusWaitingInput SessionStatus = "waiting_input"
	SessionStatusClosed       SessionStatus = "closed"
)

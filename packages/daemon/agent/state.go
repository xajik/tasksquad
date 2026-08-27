package agent

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/tasksquad/daemon/tasklog"
)

// AgentEvent describes a lifecycle event that drives a Mode transition.
type AgentEvent string

const (
	// EventTaskStarted: idle → running
	EventTaskStarted AgentEvent = "task_started"
	// EventSpawnFailed: running → idle
	EventSpawnFailed AgentEvent = "spawn_failed"
	// EventUserReplied: waiting_input → running
	EventUserReplied AgentEvent = "user_replied"
	// EventHookStop: running → waiting_input (normal turn end via Stop hook)
	EventHookStop AgentEvent = "hook_stop"
	// EventHookNotification: running → waiting_input (mid-turn question via Notification hook)
	EventHookNotification AgentEvent = "hook_notification"
	// EventLearnStart: waiting_input → learning
	EventLearnStart AgentEvent = "learn_start"
	// EventCompleted: running|waiting_input|learning → idle
	EventCompleted AgentEvent = "completed"
	// EventReset: any → idle (portal-initiated reset)
	EventReset AgentEvent = "reset"
	// EventUserClosed: waiting_input → idle (user clicked "Complete session")
	EventUserClosed AgentEvent = "user_closed"
)

// validTransitions encodes the allowed (from, event) → to state transitions.
// Any (mode, event) pair not present here is rejected by Transition().
var validTransitions = map[Mode]map[AgentEvent]Mode{
	ModeIdle: {
		EventTaskStarted: ModeRunning,
		EventReset:       ModeIdle,
	},
	ModeRunning: {
		EventSpawnFailed:      ModeIdle,
		EventHookStop:         ModeWaitingInput,
		EventHookNotification: ModeWaitingInput,
		EventCompleted:        ModeIdle,
		EventReset:            ModeIdle,
	},
	ModeWaitingInput: {
		EventUserReplied: ModeRunning,
		EventLearnStart:  ModeLearning,
		EventUserClosed:  ModeIdle,
		EventCompleted:   ModeIdle,
		EventReset:       ModeIdle,
	},
	ModeLearning: {
		EventCompleted: ModeIdle,
		EventReset:     ModeIdle,
	},
}

// AgentState holds all mutable lifecycle fields for a running agent task.
// It is the single source of truth for mode transitions and all task-scoped resources.
// All fields are protected by the embedded mutex.
type AgentState struct {
	mu sync.Mutex

	// Mode and lifecycle guards
	mode       Mode
	paused     bool // when true, heartbeat is skipped
	completing bool // set before internalComplete is called; prevents double-call
	tuiBlocked bool // when true, relay stdin is gated; only settable while ModeRunning

	// Identity
	agentID   string // resolved from server on first heartbeat
	sessionID string
	taskID    string

	// Process handles (active while task runs)
	proc       *exec.Cmd
	stdinWrite io.WriteCloser // pipe or PTY master; kept open for interactive replies
	outputDone chan struct{}  // closed when streamOutput finishes draining stdout

	// tmux / FIFO
	tmuxSession string // session name while task is running (tmux path only)
	fifoPath    string // FIFO path for tmux output streaming

	// Output and transcript
	outputLines         []string
	transcriptPath      string // conversation transcript path (from Stop hook payload)
	lastTmuxCapturePath string // path to local tmux capture file for fallback when transcript is empty

	// cliSessionID pins the CLI tool's own session_id (from the hook payload,
	// distinct from the server-side sessionID above) the first time a Stop
	// hook fires for this task. Subsequent Stop hooks with a different
	// session_id are rejected — this catches an unrelated process (e.g. a
	// user manually running the CLI in the same work_dir) whose hook
	// happens to hit this agent's hook URL. Empty means "not observed yet"
	// or "provider doesn't report session_id" (check is skipped).
	cliSessionID string

	// Prompt tracking
	lastPrompt string // the initial prompt or latest reply sent to the process

	// Close sequence queue (populated during ModeLearning)
	pendingSteps  []string // steps not yet injected into tmux
	executedSteps []string // steps already completed

	// notifyPosted is set to true at the start of SetWaitingInput so that
	// StopAndPause can detect a concurrent Notification+Stop pair (Claude Code
	// fires both hooks for the same turn) and skip the duplicate notify call.
	// Reset to false in startTask (new task) and processResponse (user replied).
	notifyPosted bool

	// hookMessage holds the turn's assistant text delivered via a provider-specific
	// hook (currently codex "last-assistant-message"). Used as the first priority
	// in internalComplete's finalText chain so Codex tasks get clean output even
	// though they have no transcript file. Cleared after each use.
	hookMessage string

	// Timing
	startedAt      time.Time // when the current task started
	lastPollAt     time.Time // last successful heartbeat
	lastActivityAt time.Time // last meaningful task event (start, hook fired)

	// Log handles
	runLog      *os.File
	lastLogPath string
	taskLog     *tasklog.TaskLog
}

// Transition validates and applies a mode change driven by event.
// Returns an error (and leaves mode unchanged) if the transition is not valid.
func (s *AgentState) Transition(event AgentEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next, ok := validTransitions[s.mode][event]
	if !ok {
		return fmt.Errorf("invalid transition: %s -[%s]-> ? (no rule defined)", s.mode, event)
	}
	s.mode = next
	s.tuiBlocked = false
	return nil
}

// SetTUIBlocked sets whether relay stdin is currently gated. Only takes
// effect while the agent is in ModeRunning; a no-op otherwise.
func (s *AgentState) SetTUIBlocked(blocked bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.mode != ModeRunning {
		return
	}
	s.tuiBlocked = blocked
}

// TUIBlocked reports whether relay stdin is currently gated.
func (s *AgentState) TUIBlocked() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tuiBlocked
}

// Mode returns the current mode as a string (satisfies external interface callers).
func (s *AgentState) Mode() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return string(s.mode)
}

// ModeValue returns the current mode as the Mode type.
func (s *AgentState) ModeValue() Mode {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mode
}

// TaskID returns the current task ID.
func (s *AgentState) TaskID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.taskID
}

// Session returns the current tmux session name.
func (s *AgentState) Session() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tmuxSession
}

// SessionID returns the server-side (D1) session ID for the current task.
func (s *AgentState) SessionID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessionID
}

// PinCLISessionID pins sessionID (the CLI tool's own hook-reported session_id)
// as the one legitimate source for this task's hooks the first time it's
// called, and reports whether subsequent calls match. Returns true when
// sessionID is empty (provider doesn't report one — nothing to check) or
// matches the pinned value; false when it conflicts with an already-pinned
// value, meaning the hook likely came from a different CLI process than the
// one this agent spawned.
func (s *AgentState) PinCLISessionID(sessionID string) bool {
	if sessionID == "" {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cliSessionID == "" {
		s.cliSessionID = sessionID
		return true
	}
	return s.cliSessionID == sessionID
}

// LogPath returns the path to the current per-task run log file.
func (s *AgentState) LogPath() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastLogPath
}

// LastActivityAt returns the time of the last meaningful task event.
func (s *AgentState) LastActivityAt() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastActivityAt
}

// LastPollAt returns the time of the last successful heartbeat poll.
func (s *AgentState) LastPollAt() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastPollAt
}

// Paused returns whether the poll loop is currently paused.
func (s *AgentState) Paused() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.paused
}

// CloseSteps returns a snapshot of the pending and executed close-sequence steps.
func (s *AgentState) CloseSteps() (pending []string, executed []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.pendingSteps...), append([]string{}, s.executedSteps...)
}

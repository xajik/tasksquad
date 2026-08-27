package agent

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tasksquad/daemon/agentmode"
	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/provider"
)

// tmuxBin is the path to the tmux binary, or empty if tmux is not installed.
var tmuxBin string

func init() {
	if p, err := exec.LookPath("tmux"); err == nil {
		tmuxBin = p
	}
}

// Re-export agentmode types so callers that currently reference agent.Mode keep working.
type Mode = agentmode.Mode

const (
	ModeIdle         = agentmode.ModeIdle
	ModeRunning      = agentmode.ModeRunning
	ModeWaitingInput = agentmode.ModeWaitingInput
	ModeLearning     = agentmode.ModeLearning
)

// Agent is the runtime representation of a configured agent process.
// Behaviour is spread across focused files in this package:
//
//	agent.go          — struct, constructor, accessors
//	lifecycle.go      — startTask (process spawn)
//	session.go        — Complete, StopAndPause, closeSession, handleReset, startCloseSequence
//	complete.go       — internalComplete and its helpers
//	response.go       — processResponse, SetWaitingInput, PushIntermediateResponse
//	streaming.go      — streamOutput, writeRunLog
//	terminal_relay.go — live PTY byte relay via Durable Object WebSocket
//	transcript.go     — transcript reading and extractFinalText
//	upload.go         — R2 artifact uploads
type Agent struct {
	Config        config.AgentConfig
	prov          provider.Provider
	st            *AgentState
	relayConn     *websocket.Conn // live terminal relay WS; nil when idle
	portalActive  int32           // atomic: 1 while a portal goroutine is running
	portalSignals chan string      // receives portal IDs to close (buffered 1)

	portalMu       sync.Mutex // guards activePortalID
	activePortalID string     // ID of the currently running portal, "" when idle
}

// New creates an Agent from the given config, detecting the provider from the command.
func New(cfg config.AgentConfig) *Agent {
	return &Agent{
		Config:        cfg,
		prov:          provider.Detect(cfg.Command, cfg.Provider),
		portalSignals: make(chan string, 1),
		st: &AgentState{
			agentID: cfg.ID,
			mode:    ModeIdle,
		},
	}
}

// ── Accessors ─────────────────────────────────────────────────────────────────

// Name implements the ui.AgentStatus interface.
func (a *Agent) Name() string { return a.Config.Name }

// ID returns the server-assigned agent ID. Used to identify hooks uniquely
// even when multiple agents share the same display name.
func (a *Agent) ID() string { return a.Config.ID }

// AgentID implements ui.AgentStatus — same as ID().
func (a *Agent) AgentID() string { return a.Config.ID }

// WorkDir implements ui.AgentStatus — returns the configured working directory.
func (a *Agent) WorkDir() string { return a.Config.WorkDir }

// Command implements ui.AgentStatus — returns the CLI command string.
func (a *Agent) Command() string { return a.Config.Command }

// Provider implements ui.AgentStatus — returns the provider name.
func (a *Agent) Provider() string { return a.prov.Name() }

// GetMode implements the hooks.Agent and ui.AgentStatus interfaces.
func (a *Agent) GetMode() string { return a.st.Mode() }

// IsLearning returns true when the agent is in the close-sequence phase.
func (a *Agent) IsLearning() bool { return a.st.ModeValue() == ModeLearning }

// AdvanceCloseStep implements hooks.Agent — marks the current close step done
// and injects the next, or calls Complete when the queue is exhausted.
func (a *Agent) AdvanceCloseStep(cfg *config.Config) { a.advanceCloseStep(cfg) }

// CloseSteps returns a snapshot of the pending and executed close-sequence steps.
func (a *Agent) CloseSteps() (pending []string, executed []string) { return a.st.CloseSteps() }

// GetTaskID returns the task ID the agent is currently working on.
func (a *Agent) GetTaskID() string { return a.st.TaskID() }

// PinCLISessionID implements hooks.Agent — see AgentState.PinCLISessionID.
func (a *Agent) PinCLISessionID(sessionID string) bool { return a.st.PinCLISessionID(sessionID) }

// SetTUIBlocked implements hooks.Agent — see AgentState.SetTUIBlocked.
func (a *Agent) SetTUIBlocked(blocked bool) { a.st.SetTUIBlocked(blocked) }

// SetHookMessage stores an assistant message delivered by a provider-specific
// hook (e.g. codex "last-assistant-message"). internalComplete reads it as the
// first priority for finalText.
func (a *Agent) SetHookMessage(msg string) {
	a.st.mu.Lock()
	a.st.hookMessage = msg
	a.st.mu.Unlock()
}

// GetLastTmuxCapture returns the stored tmux capture for fallback when
// transcript is unavailable. Reads from local file if path exists.
func (a *Agent) GetLastTmuxCapture() string {
	a.st.mu.Lock()
	path := a.st.lastTmuxCapturePath
	a.st.mu.Unlock()

	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		logger.Debug(fmt.Sprintf("[%s] Failed to read tmux capture file: %v", a.Config.Name, err))
		return ""
	}
	return strings.TrimSpace(string(data))
}

// Pause stops the heartbeat poll loop until Resume is called.
func (a *Agent) Pause() {
	a.st.mu.Lock()
	a.st.paused = true
	a.st.mu.Unlock()
	logger.Info(fmt.Sprintf("[%s] Pulling paused", a.Config.Name))
}

// Resume re-enables the heartbeat poll loop.
func (a *Agent) Resume() {
	a.st.mu.Lock()
	a.st.paused = false
	a.st.mu.Unlock()
	logger.Info(fmt.Sprintf("[%s] Pulling resumed", a.Config.Name))
}

// IsPaused reports whether the poll loop is currently paused.
func (a *Agent) IsPaused() bool { return a.st.Paused() }

// LastPullTime implements ui.AgentStatus — returns the time of the last successful heartbeat.
func (a *Agent) LastPullTime() time.Time { return a.st.LastPollAt() }

// LastLogPath implements ui.AgentStatus — returns the path to the current run log file.
func (a *Agent) LastLogPath() string { return a.st.LogPath() }

// GetLastActivityAt returns the time of the last meaningful task event.
func (a *Agent) GetLastActivityAt() time.Time { return a.st.LastActivityAt() }

// TmuxSession implements ui.AgentStatus — returns the active tmux session name.
func (a *Agent) TmuxSession() string { return a.st.Session() }

// SessionID returns the server-side (D1) session ID for the current task.
func (a *Agent) SessionID() string { return a.st.SessionID() }

// ── Internal helpers ──────────────────────────────────────────────────────────

// post authenticates and sends a JSON POST to the daemon API.
func (a *Agent) post(cfg *config.Config, path string, body any) (map[string]any, error) {
	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		return nil, fmt.Errorf("auth: %w", err)
	}
	return api.Post(cfg, token, a.Config.ID, path, body)
}

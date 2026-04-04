package hooks

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

// Agent is the interface the hook server uses to notify agents.
type Agent interface {
	// ID returns the server-assigned agent ID, used to route incoming hooks
	// uniquely even when multiple agents share the same display name.
	ID() string
	Name() string
	Complete(cfg *config.Config, status string, transcriptPath string)
	StopAndPause(cfg *config.Config, hookMessage, transcriptPath string)
	SetWaitingInput(cfg *config.Config, message string, transcriptPath string)
	// PushIntermediateResponse posts an agent message to the task thread without
	// pausing the task. Used by Gemini's AfterAgent hook to stream per-turn
	// responses while the session continues running.
	PushIntermediateResponse(cfg *config.Config, promptResponse, transcriptPath string)
	GetMode() string
	// GetTaskID returns the task ID the agent is currently working on.
	// Used to reject stale hook events that fired after the task changed.
	GetTaskID() string
	// IsLearning returns true when the agent is in the end-session learning phase.
	IsLearning() bool
	// SetHookMessage stores the assistant text delivered by a provider-specific
	// hook (e.g. codex last-assistant-message) so internalComplete can use it
	// as finalText without a transcript file.
	SetHookMessage(message string)
}

// SupervisorReporter is implemented by the supervisor package and allows the
// hook server to deliver verdicts and cancellations without a circular import.
type SupervisorReporter interface {
	// HandleVerdict delivers a verdict from POST /hooks/supervisor to the
	// waiting spawn() goroutine for the given task.
	HandleVerdict(taskID, status, summary, found, action string)
	// CancelForTask kills any active supervisor session for the task.
	// Called when the monitored agent's Stop hook fires.
	CancelForTask(taskID string)
}

// StartHookServer starts a local HTTP server that receives lifecycle events from
// CLI providers and dispatches them to the appropriate agent.
//
// Registered endpoints:
//
//	POST /hooks/stop         — provider Stop hook (task finished or failed)
//	POST /hooks/notification — provider Notification hook (waiting for input)
//	POST /hooks/after_agent  — Gemini per-turn response
//	POST /hooks/opencode     — OpenCode lifecycle events
//	POST /hooks/codex        — Codex turn completion
//	POST /hooks/skill        — agent pushes a learned skill
//	POST /hooks/supervisor   — supervisor verdict
func StartHookServer(cfg *config.Config, agents []Agent, reporter SupervisorReporter) {
	srv := &hookServer{cfg: cfg, agents: agents, reporter: reporter}
	mux := http.NewServeMux()

	mux.HandleFunc("/hooks/stop", srv.handleStop)
	mux.HandleFunc("/hooks/notification", srv.handleNotification)
	mux.HandleFunc("/hooks/after_agent", srv.handleAfterAgent)
	mux.HandleFunc("/hooks/opencode", srv.handleOpenCode)
	mux.HandleFunc("/hooks/codex", srv.handleCodex)
	mux.HandleFunc("/hooks/skill", srv.handleSkill)
	mux.HandleFunc("/hooks/supervisor", srv.handleSupervisor)

	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Hooks.Port)
	logger.Info(fmt.Sprintf("[hooks] Server listening on http://localhost:%d", cfg.Hooks.Port))
	logger.Info("[hooks] Registered endpoints: /hooks/stop (Stop + StopFailure), /hooks/notification, /hooks/after_agent, /hooks/opencode, /hooks/skill, /hooks/supervisor")
	go http.ListenAndServe(addr, mux) //nolint:errcheck
}

// findAndDispatch iterates agents, applies agentID/taskID filters, and calls fn
// on the first matching agent. Returns true if a match was found.
// A mismatched taskID is logged as a stale-hook warning and the agent is skipped.
func findAndDispatch(agents []Agent, agentID, taskIDParam string, fn func(Agent)) bool {
	for _, a := range agents {
		if agentID != "" && a.ID() != agentID {
			continue
		}
		if currentTaskID := a.GetTaskID(); taskIDParam != "" && currentTaskID != taskIDParam {
			logger.Warn(fmt.Sprintf("[hooks] stale hook task_id=%q does not match agent %s current task %q — ignoring", taskIDParam, a.Name(), currentTaskID))
			continue
		}
		fn(a)
		return true
	}
	return false
}

func getAgentModes(agents []Agent) string {
	var modes []string
	for _, a := range agents {
		modes = append(modes, fmt.Sprintf("%s:%s", a.Name(), a.GetMode()))
	}
	return strings.Join(modes, ", ")
}

// writeJSON writes a JSON response with the given status code. Claude Code HTTP
// hooks require a valid JSON body; returning plain "ok" text causes the hook to
// fail with "JSON validation failed", which leaves the session stuck at ❯ Result?
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body) //nolint:errcheck
}

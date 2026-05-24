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
	// IsLearning returns true when the agent is in the close-sequence phase.
	IsLearning() bool
	// AdvanceCloseStep marks the current close step as done and injects the next,
	// or calls Complete when the queue is exhausted.
	AdvanceCloseStep(cfg *config.Config)
	// SetHookMessage stores the assistant text delivered by a provider-specific
	// hook (e.g. codex last-assistant-message) so internalComplete can use it
	// as finalText without a transcript file.
	SetHookMessage(message string)
	// GetLastTmuxCapture returns the stored tmux capture for fallback when
	// transcript is unavailable. Returns empty string if not available.
	GetLastTmuxCapture() string
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
	// TriggerForTask immediately spawns a supervisor session for the given task.
	// Returns an error if the supervisor is disabled, already active, or no
	// agent is running that task.
	TriggerForTask(taskID string) error
}

// corsMiddleware adds CORS headers so the local portal (localhost:5173) can
// call the hooks server directly from the browser. The daemon only listens on
// 127.0.0.1, so allowing all origins is safe — external hosts cannot reach it.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// StartHookServer starts a local HTTP server that receives lifecycle events from
// CLI providers and dispatches them to the appropriate agent.
//
// Registered endpoints:
//
//	POST /hooks/stop               — provider Stop hook; speech=true param routes to speech handler
//	POST /hooks/notification       — provider Notification hook (waiting for input)
//	POST /hooks/after_agent        — Gemini per-turn response
//	POST /hooks/opencode           — OpenCode lifecycle events
//	POST /hooks/codex              — Codex turn completion
//	POST /hooks/skill              — agent pushes a learned skill
//	POST /hooks/supervisor         — supervisor verdict
//	POST /hooks/trigger-supervisor — manual supervisor trigger from portal
func StartHookServer(cfg *config.Config, agents []Agent, reporter SupervisorReporter, speechHandler SpeechToMDHandler) {
	srv := &hookServer{cfg: cfg, agents: agents, reporter: reporter, speechHandler: speechHandler}
	mux := http.NewServeMux()

	mux.HandleFunc("/hooks/stop", srv.handleStop)
	mux.HandleFunc("/hooks/notification", srv.handleNotification)
	mux.HandleFunc("/hooks/after_agent", srv.handleAfterAgent)
	mux.HandleFunc("/hooks/opencode", srv.handleOpenCode)
	mux.HandleFunc("/hooks/codex", srv.handleCodex)
	mux.HandleFunc("/hooks/skill", srv.handleSkill)
	mux.HandleFunc("/hooks/supervisor", srv.handleSupervisor)
	mux.HandleFunc("/hooks/trigger-supervisor", srv.handleTriggerSupervisor)

	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Hooks.Port)
	logger.Info(fmt.Sprintf("[hooks] Server listening on http://localhost:%d", cfg.Hooks.Port))
	logger.Info("[hooks] Registered endpoints: /hooks/stop (speech=true for voice), /hooks/notification, /hooks/after_agent, /hooks/opencode, /hooks/skill, /hooks/supervisor, /hooks/trigger-supervisor")
	go http.ListenAndServe(addr, corsMiddleware(mux)) //nolint:errcheck
}

// findAndDispatch iterates agents, applies agentID/taskID filters, and calls fn
// on the first matching agent. Returns true if a match was found.
// For stale hooks (taskID mismatch), attempts to use stored tmux capture as fallback.
func findAndDispatch(agents []Agent, agentID, taskIDParam string, fn func(Agent)) bool {
	for _, a := range agents {
		if agentID != "" && a.ID() != agentID {
			continue
		}
		currentTaskID := a.GetTaskID()

		// Check for stale hook: taskID doesn't match but agent just completed this task
		if taskIDParam != "" && currentTaskID != taskIDParam && currentTaskID == "" {
			// Agent is idle - check if we have stored tmux capture for fallback
			if tmuxCapture := a.GetLastTmuxCapture(); tmuxCapture != "" {
				logger.Info(fmt.Sprintf("[hooks] Stale hook for task %s - using stored tmux capture (%d chars) as fallback",
					taskIDParam, len(tmuxCapture)))
				// Still call fn to process the hook - the agent will use stored tmuxCapture
				fn(a)
				return true
			}
		}

		// Normal case: taskID matches or no taskID filter
		if taskIDParam != "" && currentTaskID != taskIDParam {
			logger.Warn(fmt.Sprintf("[hooks] stale hook task_id=%q does not match agent %s current task %q — ignoring",
				taskIDParam, a.Name(), currentTaskID))
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

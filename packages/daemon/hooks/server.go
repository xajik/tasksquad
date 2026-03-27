package hooks

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
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

// agentMode* constants mirror the Mode values in agent/agent.go.
// Duplicated here to avoid a circular import between hooks ↔ agent.
const (
	agentModeRunning      = "running"
	agentModeWaitingInput = "waiting_input"
	agentModeLearning     = "learning"
)

// StartHookServer starts a local HTTP server that receives lifecycle events from
// CLI providers and dispatches them to the appropriate agent.
//
// Registered endpoints:
//
//	POST /hooks/stop         — claude-code Stop hook (task finished)
//	POST /hooks/notification — claude-code Notification hook (waiting for input)
//	POST /hooks/codex        — TODO: codex completion event (see provider/codex.go)
func StartHookServer(cfg *config.Config, agents []Agent, reporter SupervisorReporter) {
	mux := http.NewServeMux()

	// ── Hook Handlers: Stop / SessionEnd ──────────────────────────────────────
	mux.HandleFunc("/hooks/stop", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		logger.Info(fmt.Sprintf("[hooks] ★ POST /hooks/stop from %s body: %s", r.RemoteAddr, string(body)))

		agentID := r.URL.Query().Get("agent")
		taskIDParam := r.URL.Query().Get("task_id")
		provider := r.URL.Query().Get("provider")

		var transcriptPath string
		var stopReason string
		var crashed bool

		if provider == "gemini" {
			// Gemini payload: {"transcript_path": "...", "reason": "...", ...}
			var payload struct {
				Reason         string `json:"reason"`
				TranscriptPath string `json:"transcript_path"`
			}
			if err := json.Unmarshal(body, &payload); err != nil {
				logger.Error(fmt.Sprintf("[hooks] Failed to unmarshal Gemini SessionEnd hook: %v", err))
			}
			transcriptPath = payload.TranscriptPath
			stopReason = payload.Reason
			crashed = stopReason == "error"
		} else if provider == "opencode" {
			// OpenCode payload: {"stop_reason": "...", "message": "...", "transcript_path": "..."}
			var payload struct {
				StopReason     string `json:"stop_reason"`
				Message        string `json:"message"`
				TranscriptPath string `json:"transcript_path"`
			}
			if err := json.Unmarshal(body, &payload); err != nil {
				logger.Error(fmt.Sprintf("[hooks] Failed to unmarshal OpenCode Stop hook: %v", err))
			}
			logger.Debug(fmt.Sprintf("[hooks] OpenCode stop parsed: stop_reason=%q msg=%q transcript_path=%q",
				payload.StopReason, payload.Message, payload.TranscriptPath))
			transcriptPath = payload.TranscriptPath
			stopReason = payload.StopReason
			crashed = stopReason == "error"
			if transcriptPath == "" {
				logger.Warn("[hooks] OpenCode stop missing transcript_path - will fallback to tmux capture")
			}
		} else {
			// Claude payload: {"stop_reason": "...", "transcript_path": "..."}
			var payload struct {
				StopReason     string `json:"stop_reason"`
				TranscriptPath string `json:"transcript_path"`
			}
			if err := json.Unmarshal(body, &payload); err != nil {
				logger.Error(fmt.Sprintf("[hooks] Failed to unmarshal Claude Stop hook: %v", err))
			}
			transcriptPath = payload.TranscriptPath
			stopReason = payload.StopReason
			crashed = stopReason == "error"
		}

		logger.Info(fmt.Sprintf("[hooks] Stop received: provider=%s stop_reason=%s transcript_path=%s",
			provider, stopReason, transcriptPath))

		// For OpenCode the plugin delivers the clean assistant text in the message
		// field; pass it through so StopAndPause can use it directly as finalText
		// instead of relying on the FIFO/outputLines which may not be populated yet.
		var hookMessage string
		if provider == "opencode" {
			var ocMsg struct {
				Message string `json:"message"`
			}
			json.Unmarshal(body, &ocMsg) //nolint:errcheck
			hookMessage = ocMsg.Message
		}

		found := false
		for _, a := range agents {
			if agentID != "" && a.ID() != agentID {
				continue
			}
			if currentTaskID := a.GetTaskID(); taskIDParam != "" && currentTaskID != taskIDParam {
				logger.Warn(fmt.Sprintf("[hooks] Stop hook task_id=%q does not match agent %s current task %q — ignoring stale hook", taskIDParam, a.Name(), currentTaskID))
				continue
			}
			mode := a.GetMode()
			if mode == agentModeRunning || mode == agentModeWaitingInput || mode == agentModeLearning {
				if mode == agentModeLearning {
					// Agent finished the learning skill — fully complete the session.
					logger.Debug(fmt.Sprintf("[hooks] Dispatching Complete(closed) to learning agent %s", a.Name()))
					go a.Complete(cfg, "closed", transcriptPath)
				} else if crashed {
					logger.Debug(fmt.Sprintf("[hooks] Dispatching Complete(crashed) to agent %s", a.Name()))
					go a.Complete(cfg, "crashed", transcriptPath)
				} else {
					logger.Debug(fmt.Sprintf("[hooks] Dispatching StopAndPause to agent %s", a.Name()))
					go a.StopAndPause(cfg, hookMessage, transcriptPath)
				}
				found = true
				break
			}
		}
		if !found {
			logger.Warn(fmt.Sprintf("[hooks] Stop received but no matching active agent found (agent=%q task_id=%q)", agentID, taskIDParam))
		}

		// Cancel any supervisor session watching this task — the agent is done.
		if reporter != nil && taskIDParam != "" {
			reporter.CancelForTask(taskIDParam)
		}

		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok")) //nolint:errcheck
	})

	// ── Hook Handlers: Notification (waiting for input) ────────────────────────
	mux.HandleFunc("/hooks/notification", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		logger.Info(fmt.Sprintf("[hooks] ★ POST /hooks/notification from %s body: %s", r.RemoteAddr, string(body)))

		agentID := r.URL.Query().Get("agent")
		taskIDParam := r.URL.Query().Get("task_id")
		provider := r.URL.Query().Get("provider")

		var msg string
		var transcriptPath string

		if provider == "gemini" {
			// Gemini payload: {"message": "...", "transcript_path": "...", ...}
			var payload struct {
				Message        string `json:"message"`
				TranscriptPath string `json:"transcript_path"`
			}
			if err := json.Unmarshal(body, &payload); err != nil {
				logger.Error(fmt.Sprintf("[hooks] Failed to unmarshal Gemini Notification hook: %v", err))
			}
			msg = payload.Message
			transcriptPath = payload.TranscriptPath
		} else if provider == "opencode" {
			// OpenCode payload: {"message": "...", "transcript_path": "...", ...}
			var payload struct {
				Message        string `json:"message"`
				TranscriptPath string `json:"transcript_path"`
			}
			if err := json.Unmarshal(body, &payload); err != nil {
				logger.Error(fmt.Sprintf("[hooks] Failed to unmarshal OpenCode Notification hook: %v", err))
			}
			logger.Debug(fmt.Sprintf("[hooks] OpenCode notification parsed: msg=%q transcript_path=%q", payload.Message, payload.TranscriptPath))
			msg = payload.Message
			transcriptPath = payload.TranscriptPath
			if transcriptPath == "" {
				logger.Warn("[hooks] OpenCode notification missing transcript_path - message may not be captured correctly")
			}
		} else {
			// Claude payload: {"message": "...", "transcript_path": "..."}
			var payload struct {
				Message        string `json:"message"`
				TranscriptPath string `json:"transcript_path"`
			}
			if err := json.Unmarshal(body, &payload); err != nil {
				logger.Error(fmt.Sprintf("[hooks] Failed to unmarshal Claude Notification hook: %v", err))
			}
			msg = payload.Message
			transcriptPath = payload.TranscriptPath
		}

		if msg == "" {
			msg = "Waiting for your input"
		}
		logger.Info(fmt.Sprintf("[hooks] Notification received: provider=%s msg=%q transcript_path=%s",
			provider, msg, transcriptPath))

		found := false
		for _, a := range agents {
			if agentID != "" && a.ID() != agentID {
				continue
			}
			if currentTaskID := a.GetTaskID(); taskIDParam != "" && currentTaskID != taskIDParam {
				logger.Warn(fmt.Sprintf("[hooks] Notification hook task_id=%q does not match agent %s current task %q — ignoring stale hook", taskIDParam, a.Name(), currentTaskID))
				continue
			}
			if a.GetMode() == agentModeRunning {
				logger.Debug(fmt.Sprintf("[hooks] Dispatching SetWaitingInput to agent %s", a.Name()))
				go a.SetWaitingInput(cfg, msg, transcriptPath)
				found = true
				break
			}
		}
		if !found {
			logger.Warn(fmt.Sprintf("[hooks] Notification received but no matching active agent (agent=%q task_id=%q modes: %s)", agentID, taskIDParam, getAgentModes(agents)))
		}

		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok")) //nolint:errcheck
	})

	// ── Hook Handlers: after_agent (Gemini interactive completion) ────────────
	mux.HandleFunc("/hooks/after_agent", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		logger.Debug(fmt.Sprintf("[hooks] POST /hooks/after_agent from %s raw body: %s", r.RemoteAddr, string(body)))

		agentID := r.URL.Query().Get("agent")
		taskIDParam := r.URL.Query().Get("task_id")
		provider := r.URL.Query().Get("provider")

		// Gemini AfterAgent payload fires after each model turn (not just the final one).
		// We post the turn's response as an intermediate message without pausing the task,
		// so the portal shows per-turn progress while the session keeps running.
		// Final task completion is signalled by the SessionEnd hook (/hooks/stop).
		var payload struct {
			TranscriptPath string `json:"transcript_path"`
			PromptResponse string `json:"prompt_response"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			logger.Error(fmt.Sprintf("[hooks] Failed to unmarshal Gemini after_agent hook: %v", err))
		}

		logger.Info(fmt.Sprintf("[hooks] AfterAgent received: provider=%s transcript_path=%s prompt_response_len=%d",
			provider, payload.TranscriptPath, len(payload.PromptResponse)))

		found := false
		for _, a := range agents {
			if agentID != "" && a.ID() != agentID {
				continue
			}
			if currentTaskID := a.GetTaskID(); taskIDParam != "" && currentTaskID != taskIDParam {
				logger.Debug(fmt.Sprintf("[hooks] AfterAgent hook task_id=%q does not match agent %s current task %q — ignoring stale hook", taskIDParam, a.Name(), currentTaskID))
				continue
			}
			mode := a.GetMode()
			if mode == agentModeRunning || mode == agentModeWaitingInput {
				logger.Debug(fmt.Sprintf("[hooks] Dispatching PushIntermediateResponse to agent %s", a.Name()))
				go a.PushIntermediateResponse(cfg, payload.PromptResponse, payload.TranscriptPath)
				found = true
				break
			}
		}
		if !found {
			logger.Debug(fmt.Sprintf("[hooks] AfterAgent ignored: agent %q task_id=%q not in 'running' state", agentID, taskIDParam))
		}

		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok")) //nolint:errcheck
	})

	// ── opencode: lifecycle events ───────────────────────────────────────────
	mux.HandleFunc("/hooks/opencode", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		agentName := r.URL.Query().Get("agent")

		var payload struct {
			Type string `json:"type"`
		}
		json.Unmarshal(body, &payload) //nolint:errcheck

		logger.Info(fmt.Sprintf("[hooks] OpenCode event: %s (agent=%s)", payload.Type, agentName))
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok")) //nolint:errcheck
	})

	// ── codex: TODO ────────────────────────────────────────────────────────────
	// TODO: Map codex event payload to Complete() / SetWaitingInput() once
	// CODEX_HOOKS_SERVER_URL support is confirmed. See provider/codex.go.
	mux.HandleFunc("/hooks/codex", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		logger.Warn(fmt.Sprintf("[hooks] Codex hook received but not yet implemented: %s", body))
		w.WriteHeader(http.StatusNotImplemented)
		w.Write([]byte("codex hooks not yet implemented")) //nolint:errcheck
	})

	// ── POST /hooks/skill — agent pushes a learned skill to the server ────────
	// Called from within a running session (e.g. via curl) as part of the
	// /tsq-end-session-learning flow. Proxies the skill to POST /daemon/skills.
	mux.HandleFunc("/hooks/skill", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Content     string `json:"content"`
		}
		if err := json.Unmarshal(body, &payload); err != nil || payload.Name == "" || payload.Content == "" {
			http.Error(w, "invalid payload: name and content required", http.StatusBadRequest)
			return
		}
		if !strings.HasPrefix(payload.Name, "tsq-") {
			http.Error(w, "skill name must start with tsq-", http.StatusBadRequest)
			return
		}

		// Find the learning agent (or any agent with the given ?agent= ID).
		agentIDParam := r.URL.Query().Get("agent")
		var active Agent
		for _, a := range agents {
			if a.IsLearning() {
				active = a
				break
			}
			if agentIDParam != "" && a.ID() == agentIDParam {
				active = a
			}
		}
		if active == nil {
			logger.Warn("[hooks/skill] No active agent found for skill push")
			http.Error(w, "no active agent", http.StatusNotFound)
			return
		}

		token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
		if err != nil {
			logger.Error(fmt.Sprintf("[hooks/skill] Auth failed: %v", err))
			http.Error(w, "auth failed", http.StatusInternalServerError)
			return
		}

		resp, err := api.Post(cfg, token, active.ID(), "/daemon/skills", map[string]any{
			"name":        payload.Name,
			"description": payload.Description,
			"content":     payload.Content,
		})
		if err != nil {
			logger.Error(fmt.Sprintf("[hooks/skill] Failed to push skill %q: %v", payload.Name, err))
			http.Error(w, fmt.Sprintf("upstream error: %v", err), http.StatusBadGateway)
			return
		}

		logger.Info(fmt.Sprintf("[hooks/skill] Agent %s pushed skill %q", active.Name(), payload.Name))
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp) //nolint:errcheck
	})

	// ── POST /hooks/supervisor — supervisor agent pushes its verdict ─────────
	// Called via curl from within the supervisor tmux session after inspection.
	// Delivers the verdict to the waiting spawn() goroutine via SupervisorReporter.
	mux.HandleFunc("/hooks/supervisor", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			TaskID  string `json:"task_id"`
			Status  string `json:"status"`
			Summary string `json:"summary"`
			Found   string `json:"found"`
			Action  string `json:"action"`
		}
		if err := json.Unmarshal(body, &payload); err != nil || payload.TaskID == "" {
			http.Error(w, "invalid payload: task_id required", http.StatusBadRequest)
			return
		}
		validStatus := map[string]bool{"working_fine": true, "resolved": true, "cannot_help": true}
		if !validStatus[payload.Status] {
			http.Error(w, "status must be working_fine|resolved|cannot_help", http.StatusBadRequest)
			return
		}
		const maxFieldLen = 1000
		if len(payload.Summary) > maxFieldLen || len(payload.Found) > maxFieldLen || len(payload.Action) > maxFieldLen {
			http.Error(w, "summary/found/action fields must be ≤1000 chars", http.StatusBadRequest)
			return
		}
		logger.Info(fmt.Sprintf("[hooks/supervisor] Verdict for task %s: status=%s summary=%q",
			payload.TaskID, payload.Status, payload.Summary))
		if reporter != nil {
			reporter.HandleVerdict(payload.TaskID, payload.Status, payload.Summary, payload.Found, payload.Action)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok")) //nolint:errcheck
	})

	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Hooks.Port)
	logger.Info(fmt.Sprintf("[hooks] Server listening on http://localhost:%d", cfg.Hooks.Port))
	logger.Info("[hooks] Registered endpoints: /hooks/stop, /hooks/notification, /hooks/after_agent, /hooks/opencode, /hooks/skill, /hooks/supervisor")
	go http.ListenAndServe(addr, mux) //nolint:errcheck
}

func getAgentModes(agents []Agent) string {
	var modes []string
	for _, a := range agents {
		modes = append(modes, fmt.Sprintf("%s:%s", a.Name(), a.GetMode()))
	}
	return strings.Join(modes, ", ")
}

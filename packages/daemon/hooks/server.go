package hooks

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/tasksquad/daemon/agentkit"
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
		isFailure := r.URL.Query().Get("failure") == "true"

		adapter := agentkit.For(provider)
		ev, err := adapter.ParseStop(body, isFailure)
		if err != nil {
			logger.Error(fmt.Sprintf("[hooks] Failed to parse Stop hook (provider=%s): %v", provider, err))
		}
		if isFailure {
			logger.Warn(fmt.Sprintf("[hooks] StopFailure received: agent=%s task_id=%s error_type=%s", agentID, taskIDParam, ev.Reason))
		}
		if provider == "opencode" && ev.TranscriptPath == "" {
			logger.Warn("[hooks] OpenCode stop missing transcript_path - will fallback to tmux capture")
		}

		logger.Info(fmt.Sprintf("[hooks] Stop received: provider=%s stop_reason=%s transcript_path=%s",
			provider, ev.Reason, ev.TranscriptPath))

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
					go a.Complete(cfg, "closed", ev.TranscriptPath)
				} else if ev.IsFailure {
					logger.Debug(fmt.Sprintf("[hooks] Dispatching Complete(crashed) to agent %s", a.Name()))
					go a.Complete(cfg, "crashed", ev.TranscriptPath)
				} else {
					logger.Debug(fmt.Sprintf("[hooks] Dispatching StopAndPause to agent %s", a.Name()))
					go a.StopAndPause(cfg, ev.HookMessage, ev.TranscriptPath)
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

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// ── Hook Handlers: Notification (waiting for input) ────────────────────────
	mux.HandleFunc("/hooks/notification", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		logger.Info(fmt.Sprintf("[hooks] ★ POST /hooks/notification from %s body: %s", r.RemoteAddr, string(body)))

		agentID := r.URL.Query().Get("agent")
		taskIDParam := r.URL.Query().Get("task_id")
		provider := r.URL.Query().Get("provider")

		nev, err := agentkit.For(provider).ParseNotification(body)
		if err != nil {
			logger.Error(fmt.Sprintf("[hooks] Failed to parse Notification hook (provider=%s): %v", provider, err))
		}
		if provider == "opencode" {
			logger.Debug(fmt.Sprintf("[hooks] OpenCode notification parsed: msg=%q transcript_path=%q", nev.Message, nev.TranscriptPath))
			if nev.TranscriptPath == "" {
				logger.Warn("[hooks] OpenCode notification missing transcript_path - message may not be captured correctly")
			}
		}

		msg := nev.Message
		if msg == "" {
			msg = "Waiting for your input"
		}
		logger.Info(fmt.Sprintf("[hooks] Notification received: provider=%s msg=%q transcript_path=%s",
			provider, msg, nev.TranscriptPath))

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
				go a.SetWaitingInput(cfg, msg, nev.TranscriptPath)
				found = true
				break
			}
		}
		if !found {
			logger.Warn(fmt.Sprintf("[hooks] Notification received but no matching active agent (agent=%q task_id=%q modes: %s)", agentID, taskIDParam, getAgentModes(agents)))
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// ── Hook Handlers: after_agent (Gemini interactive completion) ────────────
	mux.HandleFunc("/hooks/after_agent", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		logger.Debug(fmt.Sprintf("[hooks] POST /hooks/after_agent from %s raw body: %s", r.RemoteAddr, string(body)))

		agentID := r.URL.Query().Get("agent")
		taskIDParam := r.URL.Query().Get("task_id")
		provider := r.URL.Query().Get("provider")

		// AfterAgent fires after each model turn (currently only Gemini).
		// We post the turn's response as an intermediate message without pausing the task,
		// so the portal shows per-turn progress while the session keeps running.
		// Final task completion is signalled by the SessionEnd hook (/hooks/stop).
		aev, err := agentkit.For(provider).ParseAfterAgent(body)
		if err != nil {
			logger.Error(fmt.Sprintf("[hooks] Failed to parse AfterAgent hook (provider=%s): %v", provider, err))
		}

		logger.Info(fmt.Sprintf("[hooks] AfterAgent received: provider=%s transcript_path=%s prompt_response_len=%d",
			provider, aev.TranscriptPath, len(aev.PromptResponse)))

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
				go a.PushIntermediateResponse(cfg, aev.PromptResponse, aev.TranscriptPath)
				found = true
				break
			}
		}
		if !found {
			logger.Debug(fmt.Sprintf("[hooks] AfterAgent ignored: agent %q task_id=%q not in 'running' state", agentID, taskIDParam))
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
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
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// ── codex: agent-turn-complete ───────────────────────────────────────────
	// Codex fires its notify command (shell: cat | curl -X POST) after each turn.
	// Payload: {"type":"agent-turn-complete","turn-id":"...","last-assistant-message":"..."}
	// We store the message in agent state; internalComplete reads it as finalText
	// (first priority) when the process exits and complete() is called.
	mux.HandleFunc("/hooks/codex", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		logger.Info(fmt.Sprintf("[hooks] POST /hooks/codex from %s", r.RemoteAddr))

		agentID := r.URL.Query().Get("agent")
		taskIDParam := r.URL.Query().Get("task_id")

		var payload struct {
			Type                 string `json:"type"`
			TurnID               string `json:"turn-id"`
			LastAssistantMessage string `json:"last-assistant-message"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			logger.Error(fmt.Sprintf("[hooks] Failed to unmarshal codex hook: %v", err))
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid payload"})
			return
		}

		found := false
		for _, a := range agents {
			if agentID != "" && a.ID() != agentID {
				continue
			}
			if currentTaskID := a.GetTaskID(); taskIDParam != "" && currentTaskID != taskIDParam {
				logger.Debug(fmt.Sprintf("[hooks] Codex hook task_id=%q does not match agent %s current task %q — ignoring stale hook", taskIDParam, a.Name(), currentTaskID))
				continue
			}
			if a.GetMode() == agentModeRunning {
				a.SetHookMessage(payload.LastAssistantMessage)
				logger.Info(fmt.Sprintf("[hooks] Codex turn complete for agent %s (turn-id=%s msg_len=%d)", a.Name(), payload.TurnID, len(payload.LastAssistantMessage)))
				found = true
			}
			break
		}
		if !found {
			logger.Debug(fmt.Sprintf("[hooks] Codex hook: no matching running agent for agent=%q task_id=%q", agentID, taskIDParam))
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
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
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Hooks.Port)
	logger.Info(fmt.Sprintf("[hooks] Server listening on http://localhost:%d", cfg.Hooks.Port))
	logger.Info("[hooks] Registered endpoints: /hooks/stop (Stop + StopFailure), /hooks/notification, /hooks/after_agent, /hooks/opencode, /hooks/skill, /hooks/supervisor")
	go http.ListenAndServe(addr, mux) //nolint:errcheck
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

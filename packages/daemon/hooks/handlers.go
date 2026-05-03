package hooks

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	hookadapter "github.com/tasksquad/daemon/adapter"
	"github.com/tasksquad/daemon/agentmode"
	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

// unsafeCharsRe matches non-printable and control characters (except tab, LF, CR).
// Used to strip potentially dangerous characters from supervisor verdict fields
// before they are stored or displayed in the portal.
var unsafeCharsRe = regexp.MustCompile(`[^\x09\x0A\x0D\x20-\x7E]`)

// hookServer holds the shared state needed by every hook handler.
type hookServer struct {
	cfg          *config.Config
	agents       []Agent
	reporter     SupervisorReporter
	speechHandler SpeechToMDHandler // nil when speech-to-md feature is not active
}

// handleStop handles POST /hooks/stop.
// Dispatches to Complete (on failure or learning) or StopAndPause (normal turn end).
func (s *hookServer) handleStop(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	logger.Info(fmt.Sprintf("[hooks] ★ POST /hooks/stop from %s body: %s", r.RemoteAddr, string(body)))

	agentID := r.URL.Query().Get("agent")
	taskIDParam := r.URL.Query().Get("task_id")
	provider := r.URL.Query().Get("provider")
	isFailure := r.URL.Query().Get("failure") == "true"

	adpt := hookadapter.For(provider)
	ev, err := adpt.ParseStop(body, isFailure)
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

	// Speech-to-md turn completion — dispatch to speech handler and return early.
	if r.URL.Query().Get("speech") == "true" {
		if s.speechHandler != nil {
			// Always read full content from the transcript file.
			// Payload fields (last_assistant_message, prompt_response) are truncated
			// summaries; the file contains the complete assistant response.
			var message string
			if ev.TranscriptPath != "" {
				message = adpt.ExtractTranscript(ev.TranscriptPath)
			}
			logger.Info(fmt.Sprintf("[hooks] speech stop: transcript_path=%q message_len=%d", ev.TranscriptPath, len(message)))
			s.speechHandler.HandleNotification(message)
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}

	found := findAndDispatch(s.agents, agentID, taskIDParam, func(a Agent) {
		switch agentmode.Mode(a.GetMode()) {
		case agentmode.ModeLearning:
			logger.Debug(fmt.Sprintf("[hooks] Advancing close step for agent %s", a.Name()))
			go a.AdvanceCloseStep(s.cfg)
		case agentmode.ModeRunning, agentmode.ModeWaitingInput:
			if ev.IsFailure {
				logger.Debug(fmt.Sprintf("[hooks] Dispatching Complete(crashed) to agent %s", a.Name()))
				go a.Complete(s.cfg, string(agentmode.StatusCrashed), ev.TranscriptPath)
			} else {
				logger.Debug(fmt.Sprintf("[hooks] Dispatching StopAndPause to agent %s", a.Name()))
				go a.StopAndPause(s.cfg, ev.HookMessage, ev.TranscriptPath)
			}
		}
	})
	if !found {
		logger.Warn(fmt.Sprintf("[hooks] Stop received but no matching active agent found (agent=%q task_id=%q)", agentID, taskIDParam))
	}

	if s.reporter != nil && taskIDParam != "" {
		s.reporter.CancelForTask(taskIDParam)
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleNotification handles POST /hooks/notification.
// Fires when the CLI is waiting for user input.
func (s *hookServer) handleNotification(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	logger.Info(fmt.Sprintf("[hooks] ★ POST /hooks/notification from %s body: %s", r.RemoteAddr, string(body)))

	agentID := r.URL.Query().Get("agent")
	taskIDParam := r.URL.Query().Get("task_id")
	provider := r.URL.Query().Get("provider")

	nev, err := hookadapter.For(provider).ParseNotification(body)
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

	found := findAndDispatch(s.agents, agentID, taskIDParam, func(a Agent) {
		if agentmode.Mode(a.GetMode()) == agentmode.ModeRunning {
			logger.Debug(fmt.Sprintf("[hooks] Dispatching SetWaitingInput to agent %s", a.Name()))
			go a.SetWaitingInput(s.cfg, msg, nev.TranscriptPath)
		}
	})
	if !found {
		logger.Warn(fmt.Sprintf("[hooks] Notification received but no matching active agent (agent=%q task_id=%q modes: %s)", agentID, taskIDParam, getAgentModes(s.agents)))
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleAfterAgent handles POST /hooks/after_agent.
// Fires after each model turn (currently Gemini only); streams per-turn responses.
func (s *hookServer) handleAfterAgent(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	logger.Debug(fmt.Sprintf("[hooks] POST /hooks/after_agent from %s raw body: %s", r.RemoteAddr, string(body)))

	agentID := r.URL.Query().Get("agent")
	taskIDParam := r.URL.Query().Get("task_id")
	provider := r.URL.Query().Get("provider")

	aev, err := hookadapter.For(provider).ParseAfterAgent(body)
	if err != nil {
		logger.Error(fmt.Sprintf("[hooks] Failed to parse AfterAgent hook (provider=%s): %v", provider, err))
	}

	logger.Info(fmt.Sprintf("[hooks] AfterAgent received: provider=%s transcript_path=%s prompt_response_len=%d",
		provider, aev.TranscriptPath, len(aev.PromptResponse)))

	found := findAndDispatch(s.agents, agentID, taskIDParam, func(a Agent) {
		mode := agentmode.Mode(a.GetMode())
		if mode == agentmode.ModeRunning || mode == agentmode.ModeWaitingInput {
			logger.Debug(fmt.Sprintf("[hooks] Dispatching PushIntermediateResponse to agent %s (AfterAgent)", a.Name()))
			go a.PushIntermediateResponse(s.cfg, aev.PromptResponse, aev.TranscriptPath)
		}
	})
	if !found {
		logger.Debug(fmt.Sprintf("[hooks] AfterAgent ignored: agent %q task_id=%q not in 'running' state", agentID, taskIDParam))
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleOpenCode handles POST /hooks/opencode.
// Receives generic lifecycle events from the OpenCode plugin (currently log-only).
func (s *hookServer) handleOpenCode(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	agentName := r.URL.Query().Get("agent")

	var payload struct {
		Type string `json:"type"`
	}
	json.Unmarshal(body, &payload) //nolint:errcheck

	logger.Info(fmt.Sprintf("[hooks] OpenCode event: %s (agent=%s)", payload.Type, agentName))
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleCodex handles POST /hooks/codex.
// Codex fires this after each turn; we store the last assistant message so
// internalComplete can use it as finalText without a transcript file.
func (s *hookServer) handleCodex(w http.ResponseWriter, r *http.Request) {
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

	found := findAndDispatch(s.agents, agentID, taskIDParam, func(a Agent) {
		if agentmode.Mode(a.GetMode()) == agentmode.ModeRunning {
			a.SetHookMessage(payload.LastAssistantMessage)
			logger.Info(fmt.Sprintf("[hooks] Codex turn complete for agent %s (turn-id=%s msg_len=%d)", a.Name(), payload.TurnID, len(payload.LastAssistantMessage)))
		}
	})
	if !found {
		logger.Debug(fmt.Sprintf("[hooks] Codex hook: no matching running agent for agent=%q task_id=%q", agentID, taskIDParam))
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleSkill handles POST /hooks/skill.
// Called from within a running session to push a learned skill to the server.
func (s *hookServer) handleSkill(w http.ResponseWriter, r *http.Request) {
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

	agentIDParam := r.URL.Query().Get("agent")
	var active Agent
	for _, a := range s.agents {
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

	token, err := auth.GetToken(s.cfg.Firebase.APIKey, s.cfg.Server.URL)
	if err != nil {
		logger.Error(fmt.Sprintf("[hooks/skill] Auth failed: %v", err))
		http.Error(w, "auth failed", http.StatusInternalServerError)
		return
	}

	resp, err := api.Post(s.cfg, token, active.ID(), "/daemon/skills", map[string]any{
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
}

// handleSupervisor handles POST /hooks/supervisor.
// Called via curl from the supervisor tmux session to deliver a verdict.
func (s *hookServer) handleSupervisor(w http.ResponseWriter, r *http.Request) {
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
	switch payload.Status {
	case "working_fine", "resolved", "cannot_help":
		// valid
	default:
		http.Error(w, "status must be working_fine|resolved|cannot_help", http.StatusBadRequest)
		return
	}
	const maxFieldLen = 1000
	if len(payload.Summary) > maxFieldLen || len(payload.Found) > maxFieldLen || len(payload.Action) > maxFieldLen {
		http.Error(w, "summary/found/action fields must be ≤1000 chars", http.StatusBadRequest)
		return
	}
	// Strip non-printable/control characters to prevent XSS or display corruption.
	payload.Summary = unsafeCharsRe.ReplaceAllString(payload.Summary, "")
	payload.Found = unsafeCharsRe.ReplaceAllString(payload.Found, "")
	payload.Action = unsafeCharsRe.ReplaceAllString(payload.Action, "")

	logger.Info(fmt.Sprintf("[hooks/supervisor] Verdict for task %s: status=%s summary=%q",
		payload.TaskID, payload.Status, payload.Summary))
	if s.reporter != nil {
		s.reporter.HandleVerdict(payload.TaskID, payload.Status, payload.Summary, payload.Found, payload.Action)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

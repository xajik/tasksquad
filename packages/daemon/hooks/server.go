package hooks

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

// Agent is the interface the hook server uses to notify agents.
type Agent interface {
	Name() string
	Complete(cfg *config.Config, status string, transcriptPath string)
	SetWaitingInput(cfg *config.Config, message string, transcriptPath string)
	GetMode() string
}

// StartHookServer starts a local HTTP server that receives lifecycle events from
// CLI providers and dispatches them to the appropriate agent.
//
// Registered endpoints:
//
//	POST /hooks/stop         — claude-code Stop hook (task finished)
//	POST /hooks/notification — claude-code Notification hook (waiting for input)
//	POST /hooks/codex        — TODO: codex completion event (see provider/codex.go)
func StartHookServer(cfg *config.Config, agents []Agent) {
	mux := http.NewServeMux()

	// ── claude-code: Stop ──────────────────────────────────────────────────────
	mux.HandleFunc("/hooks/stop", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		logger.Debug(fmt.Sprintf("[hooks] POST /hooks/stop raw body: %s", string(body)))

		var payload struct {
			StopReason     string `json:"stop_reason"`
			SessionID      string `json:"session_id"`
			TranscriptPath string `json:"transcript_path"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			logger.Error(fmt.Sprintf("[hooks] Failed to unmarshal Stop hook: %v", err))
		}

		logger.Info(fmt.Sprintf("[hooks] Stop received: stop_reason=%s transcript_path=%s session_id=%s", 
			payload.StopReason, payload.TranscriptPath, payload.SessionID))

		status := "closed"
		if payload.StopReason == "error" {
			status = "crashed"
		}

		found := false
		for _, a := range agents {
			if a.GetMode() == "running" || a.GetMode() == "waiting_input" {
				logger.Debug(fmt.Sprintf("[hooks] Dispatching Complete to agent %s", a.Name()))
				go a.Complete(cfg, status, payload.TranscriptPath)
				found = true
				break
			}
		}
		if !found {
			logger.Warn("[hooks] Stop received but no active agent found to handle it")
		}

		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok")) //nolint:errcheck
	})

	// ── claude-code: Notification (waiting for input) ──────────────────────────
	mux.HandleFunc("/hooks/notification", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		logger.Debug(fmt.Sprintf("[hooks] POST /hooks/notification raw body: %s", string(body)))

		var payload struct {
			Message        string `json:"message"`
			TranscriptPath string `json:"transcript_path"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			logger.Error(fmt.Sprintf("[hooks] Failed to unmarshal Notification hook: %v", err))
		}

		msg := payload.Message
		if msg == "" {
			msg = "Waiting for your input"
		}
		logger.Info(fmt.Sprintf("[hooks] Notification received: %s  transcript_path=%s", msg, payload.TranscriptPath))

		found := false
		for _, a := range agents {
			if a.GetMode() == "running" {
				logger.Debug(fmt.Sprintf("[hooks] Dispatching SetWaitingInput to agent %s", a.Name()))
				go a.SetWaitingInput(cfg, msg, payload.TranscriptPath)
				found = true
				break
			}
		}
		if !found {
			logger.Warn(fmt.Sprintf("[hooks] Notification received but no agent in 'running' mode (current modes: %s)", getAgentModes(agents)))
		}

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

	addr := fmt.Sprintf(":%d", cfg.Hooks.Port)
	logger.Info(fmt.Sprintf("[hooks] Server listening on http://localhost%s", addr))
	go http.ListenAndServe(addr, mux) //nolint:errcheck
}

func getAgentModes(agents []Agent) string {
	var modes []string
	for _, a := range agents {
		modes = append(modes, fmt.Sprintf("%s:%s", a.Name(), a.GetMode()))
	}
	return strings.Join(modes, ", ")
}

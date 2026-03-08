package hooks

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

// Agent is the interface the hook server uses to notify agents.
type Agent interface {
	Complete(cfg *config.Config, status string, transcriptPath string)
	SetWaitingInput(cfg *config.Config, message string)
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
		var payload struct {
			StopReason     string `json:"stop_reason"`
			SessionID      string `json:"session_id"`
			TranscriptPath string `json:"transcript_path"`
		}
		json.Unmarshal(body, &payload)

		logger.Info(fmt.Sprintf("[hooks] Stop received: stop_reason=%s transcript_path=%s", payload.StopReason, payload.TranscriptPath))

		status := "closed"
		if payload.StopReason == "error" {
			status = "crashed"
		}

		for _, a := range agents {
			if a.GetMode() == "running" || a.GetMode() == "waiting_input" {
				go a.Complete(cfg, status, payload.TranscriptPath)
				break
			}
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok")) //nolint:errcheck
	})

	// ── claude-code: Notification (waiting for input) ──────────────────────────
	mux.HandleFunc("/hooks/notification", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Message string `json:"message"`
		}
		json.Unmarshal(body, &payload)

		msg := payload.Message
		if msg == "" {
			msg = "Waiting for your input"
		}
		logger.Info(fmt.Sprintf("[hooks] Notification received: %s", msg))

		for _, a := range agents {
			if a.GetMode() == "running" {
				go a.SetWaitingInput(cfg, msg)
				break
			}
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

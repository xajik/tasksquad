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
	StopAndPause(cfg *config.Config, transcriptPath string)
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

	// ── Hook Handlers: Stop / SessionEnd ──────────────────────────────────────
	mux.HandleFunc("/hooks/stop", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		logger.Debug(fmt.Sprintf("[hooks] POST /hooks/stop raw body: %s", string(body)))

		agentName := r.URL.Query().Get("agent")
		provider := r.URL.Query().Get("provider")

		var transcriptPath string
		var stopReason string
		var crashed bool

		if provider == "gemini" {
			// Gemini payload: {"event": "SessionEnd", "data": {"reason": "...", "transcriptPath": "..."}}
			var payload struct {
				Data struct {
					Reason         string `json:"reason"`
					TranscriptPath string `json:"transcriptPath"`
				} `json:"data"`
			}
			if err := json.Unmarshal(body, &payload); err != nil {
				logger.Error(fmt.Sprintf("[hooks] Failed to unmarshal Gemini SessionEnd hook: %v", err))
			}
			transcriptPath = payload.Data.TranscriptPath
			stopReason = payload.Data.Reason
			crashed = stopReason == "error"
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

		found := false
		for _, a := range agents {
			if agentName != "" && a.Name() != agentName {
				continue
			}
			if a.GetMode() == "running" || a.GetMode() == "waiting_input" {
				if crashed {
					logger.Debug(fmt.Sprintf("[hooks] Dispatching Complete(crashed) to agent %s", a.Name()))
					go a.Complete(cfg, "crashed", transcriptPath)
				} else {
					logger.Debug(fmt.Sprintf("[hooks] Dispatching StopAndPause to agent %s", a.Name()))
					go a.StopAndPause(cfg, transcriptPath)
				}
				found = true
				break
			}
		}
		if !found {
			logger.Warn(fmt.Sprintf("[hooks] Stop received but no matching active agent found (agent=%q)", agentName))
		}

		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok")) //nolint:errcheck
	})

	// ── Hook Handlers: Notification (waiting for input) ────────────────────────
	mux.HandleFunc("/hooks/notification", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		logger.Debug(fmt.Sprintf("[hooks] POST /hooks/notification raw body: %s", string(body)))

		agentName := r.URL.Query().Get("agent")
		provider := r.URL.Query().Get("provider")

		var msg string
		var transcriptPath string

		if provider == "gemini" {
			// Gemini payload: {"event": "Notification", "data": {"message": "...", "transcriptPath": "..."}}
			var payload struct {
				Data struct {
					Message        string `json:"message"`
					TranscriptPath string `json:"transcriptPath"`
				} `json:"data"`
			}
			if err := json.Unmarshal(body, &payload); err != nil {
				logger.Error(fmt.Sprintf("[hooks] Failed to unmarshal Gemini Notification hook: %v", err))
			}
			msg = payload.Data.Message
			transcriptPath = payload.Data.TranscriptPath
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
			if agentName != "" && a.Name() != agentName {
				continue
			}
			if a.GetMode() == "running" {
				logger.Debug(fmt.Sprintf("[hooks] Dispatching SetWaitingInput to agent %s", a.Name()))
				go a.SetWaitingInput(cfg, msg, transcriptPath)
				found = true
				break
			}
		}
		if !found {
			logger.Warn(fmt.Sprintf("[hooks] Notification received but no matching active agent (agent=%q modes: %s)", agentName, getAgentModes(agents)))
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

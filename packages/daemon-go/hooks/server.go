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
	Complete(cfg *config.Config)
	SetWaitingInput(cfg *config.Config, message string)
	GetMode() string
}

// StartHookServer starts an HTTP server that receives Claude Code hook events
// (Stop and Notification) and dispatches them to the appropriate agent.
func StartHookServer(cfg *config.Config, agents []Agent) {
	mux := http.NewServeMux()
	mux.HandleFunc("/hooks/stop", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			StopReason string `json:"stop_reason"`
			SessionID  string `json:"session_id"`
		}
		json.Unmarshal(body, &payload)

		logger.Info(fmt.Sprintf("[hooks] Stop received: stop_reason=%s", payload.StopReason))

		for _, a := range agents {
			if a.GetMode() == "running" || a.GetMode() == "waiting_input" {
				go a.Complete(cfg)
				break
			}
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	mux.HandleFunc("/hooks/notification", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Message string `json:"message"`
		}
		json.Unmarshal(body, &payload)

		msg := payload.Message
		if msg == "" {
			msg = "Claude is waiting for your input"
		}
		logger.Info(fmt.Sprintf("[hooks] Notification received: %s", msg))

		for _, a := range agents {
			if a.GetMode() == "running" {
				go a.SetWaitingInput(cfg, msg)
				break
			}
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	addr := fmt.Sprintf(":%d", cfg.Hooks.Port)
	logger.Info(fmt.Sprintf("[hooks] Server listening on http://localhost%s", addr))
	go http.ListenAndServe(addr, mux) //nolint:errcheck
}

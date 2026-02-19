package hooks

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/tasksquad/daemon/agent"
	"github.com/tasksquad/daemon/config"
)

func StartHookServer(cfg *config.Config, agents map[string]*agent.Agent) {
	mux := http.NewServeMux()

	mux.HandleFunc("/hooks/stop", func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			SessionID  string `json:"session_id"`
			StopReason string `json:"stop_reason"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		for _, a := range agents {
			if a.SessionID == payload.SessionID || a.Mode != agent.ModeIdle {
				go a.Complete(cfg)
				break
			}
		}
		w.WriteHeader(http.StatusOK)
	})

	mux.HandleFunc("/hooks/notification", func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Message string `json:"message"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		for _, a := range agents {
			if a.Mode == agent.ModeAccumulating || a.Mode == agent.ModeLive {
				go a.SetWaitingInput(cfg, payload.Message)
				break
			}
		}
		w.WriteHeader(http.StatusOK)
	})

	addr := fmt.Sprintf(":%d", cfg.Hooks.Port)
	http.ListenAndServe(addr, mux) //nolint:errcheck
}

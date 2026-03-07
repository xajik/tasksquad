package hooks

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

type Agent interface {
	Complete(cfg *config.Config)
	SetWaitingInput(cfg *config.Config, message string)
	GetMode() string
}

type Server struct {
	cfg    *config.Config
	agents map[string]Agent
}

func StartHookServer(cfg *config.Config, agents map[string]Agent) *Server {
	s := &Server{cfg: cfg, agents: agents}

	mux := http.NewServeMux()
	mux.HandleFunc("/hooks/stop", s.handleStop)
	mux.HandleFunc("/hooks/notification", s.handleNotification)

	addr := fmt.Sprintf(":%d", cfg.Hooks.Port)
	go http.ListenAndServe(addr, mux)
	logger.Info(fmt.Sprintf("[hooks] Server listening on :%d", cfg.Hooks.Port))

	return s
}

func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var payload struct {
		SessionID  string `json:"session_id"`
		StopReason string `json:"stop_reason"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	for _, a := range s.agents {
		if a.GetMode() != "idle" {
			a.Complete(s.cfg)
			break
		}
	}

	w.WriteHeader(http.StatusOK)
	logger.Info(fmt.Sprintf("[hooks] Stop received — stop_reason=%s", payload.StopReason))
}

func (s *Server) handleNotification(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var payload struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	for _, a := range s.agents {
		mode := a.GetMode()
		if mode == "accumulating" || mode == "live" {
			a.SetWaitingInput(s.cfg, payload.Message)
			break
		}
	}

	w.WriteHeader(http.StatusOK)
	logger.Info(fmt.Sprintf("[hooks] Notification received: %s", payload.Message))
}

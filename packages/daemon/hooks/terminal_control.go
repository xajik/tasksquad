package hooks

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/tasksquad/daemon/config"
)

type terminalController interface {
	SendTerminalInput(context.Context, string, string, string, []byte, bool) error
	CloseTerminalSession(*config.Config, string, string) bool
}

// These endpoints are for native local clients, not cross-origin webpages.
// Exact task/session identity is rechecked atomically by the owning agent.
func (s *hookServer) handleTerminal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405)
		return
	}
	if r.Header.Get("Origin") != "" || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "native JSON client required", 403)
		return
	}
	var body struct {
		AgentID string `json:"agent_id"`
		TaskID  string `json:"task_id"`
		Session string `json:"session"`
		Pane    string `json:"pane"`
		Data    []byte `json:"data"`
		Submit  bool   `json:"submit"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body) != nil || body.AgentID == "" || body.TaskID == "" || body.Session == "" {
		http.Error(w, "invalid terminal request", 400)
		return
	}
	for _, a := range s.agents {
		if a.ID() != body.AgentID {
			continue
		}
		controller, ok := a.(terminalController)
		if !ok {
			http.Error(w, "terminal control unavailable", 501)
			return
		}
		if r.URL.Path == "/hooks/terminal/input" {
			if err := controller.SendTerminalInput(r.Context(), body.TaskID, body.Session, body.Pane, body.Data, body.Submit); err != nil {
				http.Error(w, err.Error(), 409)
				return
			}
		} else if !controller.CloseTerminalSession(s.cfg, body.TaskID, body.Session) {
			http.Error(w, "task session changed or is already closing", 409)
			return
		}
		if s.ctrl != nil && (body.Submit || r.URL.Path == "/hooks/terminal/close") {
			s.ctrl.ForcePoll()
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Error(w, "agent not found", 404)
}

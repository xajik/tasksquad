//go:build cgo && darwin

package ui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDashboardStatus(t *testing.T) {
	t.Run("dashStatus structure", func(t *testing.T) {
		status := dashStatus{
			Email:     "test@example.com",
			DashURL:   "http://localhost:5173",
			PortalURL: "http://localhost:5173/dashboard",
			ConfigDir: "/test/config",
			Agents:    []dashAgent{},
			Sessions:  []dashSession{},
			UpdatedAt: 1234567890,
		}

		data, err := json.Marshal(status)
		if err != nil {
			t.Fatalf("failed to marshal: %v", err)
		}

		var parsed map[string]any
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatalf("failed to unmarshal: %v", err)
		}

		if parsed["email"] != "test@example.com" {
			t.Errorf("expected email 'test@example.com', got %v", parsed["email"])
		}
		if parsed["dash_url"] != "http://localhost:5173" {
			t.Errorf("expected dash_url 'http://localhost:5173', got %v", parsed["dash_url"])
		}
	})

	t.Run("dashAgent includes log_path", func(t *testing.T) {
		agent := dashAgent{
			Name:    "TestAgent",
			Mode:    "running",
			TaskID:  "task123",
			LogPath: "/test/logs/task123.log",
		}

		data, err := json.Marshal(agent)
		if err != nil {
			t.Fatalf("failed to marshal: %v", err)
		}

		var parsed map[string]any
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatalf("failed to unmarshal: %v", err)
		}

		if parsed["log_path"] != "/test/logs/task123.log" {
			t.Errorf("expected log_path '/test/logs/task123.log', got %v", parsed["log_path"])
		}
	})
}

func TestTasksLogAPI(t *testing.T) {
	t.Run("tasks-log endpoint returns raw JSONL", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/tasks-log/test-task?raw=true", nil)
		w := httptest.NewRecorder()

		handler := func(w http.ResponseWriter, r *http.Request) {
			taskID := strings.TrimPrefix(r.URL.Path, "/api/tasks-log/")
			taskID = strings.TrimSuffix(taskID, "?raw=true")
			if taskID == "" {
				http.Error(w, "missing task id", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"type":"task_start","task_id":"test-task"}` + "\n"))
			w.Write([]byte(`{"type":"message","body":"hello"}`))
		}
		handler(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", w.Code)
		}

		body := w.Body.String()
		if !strings.Contains(body, "task_start") {
			t.Errorf("expected raw JSONL with task_start, got %s", body)
		}
	})
}

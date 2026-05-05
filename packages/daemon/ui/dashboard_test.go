//go:build cgo && darwin

package ui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tasksquad/daemon/speechtomd"
)

func TestSpeechToMdAPI(t *testing.T) {
	t.Run("status returns idle when no session", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/speech-to-md/status", nil)
		w := httptest.NewRecorder()

		mgr := GetSpeechManager()
		if mgr != nil {
			mgr.StopSession()
		}

		handler := func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			m := GetSpeechManager()
			if m == nil {
				json.NewEncoder(w).Encode(map[string]any{"state": "idle"})
				return
			}
			json.NewEncoder(w).Encode(m.Status())
		}
		handler(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", w.Code)
		}

		var resp map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to parse response: %v", err)
		}

		if state, ok := resp["state"].(string); !ok || state != "idle" {
			t.Errorf("expected state 'idle', got %v", resp["state"])
		}
	})

	t.Run("session start requires agent", func(t *testing.T) {
		body := `{"agent":"","model":"base"}`
		req := httptest.NewRequest(http.MethodPost, "/api/speech-to-md/session/start", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()

		handler := func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			var b struct {
				Agent string `json:"agent"`
				Model string `json:"model"`
			}
			json.NewDecoder(r.Body).Decode(&b)
			if b.Agent == "" {
				http.Error(w, "agent required", http.StatusBadRequest)
				return
			}
			json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
		}
		handler(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("recording pause returns error when not recording", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/speech-to-md/recording/pause", nil)
		w := httptest.NewRecorder()

		handler := func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			mgr := GetSpeechManager()
			if mgr == nil {
				http.Error(w, "no active session", http.StatusBadRequest)
				return
			}
			if err := mgr.PauseRecording(); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
		}
		handler(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected status 400 when no session, got %d", w.Code)
		}
		if !strings.Contains(w.Body.String(), "no active session") {
			t.Errorf("expected 'no active session' error, got %s", w.Body.String())
		}
	})
}

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

func TestLocalModelsEndpoint(t *testing.T) {
	t.Run("returns models list from omlx", func(t *testing.T) {
		// Spin up a mock omlx server.
		omlx := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"data":[{"id":"model-a"},{"id":"model-b"}]}`)) //nolint:errcheck
		}))
		defer omlx.Close()

		req := httptest.NewRequest(http.MethodGet, "/api/speech-to-md/local-models", nil)
		w := httptest.NewRecorder()

		handler := func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			models, err := speechtomd.ListLocalModels(omlx.URL)
			if err != nil {
				json.NewEncoder(w).Encode(map[string]any{"models": []string{}, "error": err.Error()}) //nolint:errcheck
				return
			}
			if models == nil {
				models = []string{}
			}
			json.NewEncoder(w).Encode(map[string]any{"models": models}) //nolint:errcheck
		}
		handler(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		var resp map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to parse response: %v", err)
		}
		models, _ := resp["models"].([]any)
		if len(models) != 2 {
			t.Errorf("expected 2 models, got %d: %v", len(models), resp)
		}
	})

	t.Run("returns empty list with error when omlx unavailable", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/speech-to-md/local-models", nil)
		w := httptest.NewRecorder()

		handler := func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			models, err := speechtomd.ListLocalModels("http://127.0.0.1:19998")
			if err != nil {
				json.NewEncoder(w).Encode(map[string]any{"models": []string{}, "error": err.Error()}) //nolint:errcheck
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"models": models}) //nolint:errcheck
		}
		handler(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200 even on omlx error, got %d", w.Code)
		}
		var resp map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to parse response: %v", err)
		}
		if _, hasError := resp["error"]; !hasError {
			t.Error("expected 'error' field in response when omlx is unavailable")
		}
		models, _ := resp["models"].([]any)
		if len(models) != 0 {
			t.Errorf("expected empty models list on error, got %v", models)
		}
	})
}

func TestSessionStartLocalRouting(t *testing.T) {
	t.Run("agent=local requires mgr to be initialised", func(t *testing.T) {
		body := `{"agent":"local","local_model":"Qwen3-35B","model":"base"}`
		req := httptest.NewRequest(http.MethodPost, "/api/speech-to-md/session/start", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()

		handler := func(w http.ResponseWriter, r *http.Request) {
			var b struct {
				Agent      string `json:"agent"`
				Model      string `json:"model"`
				Prompt     string `json:"prompt"`
				LocalModel string `json:"local_model"`
			}
			json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
			if b.Agent == "" {
				http.Error(w, "agent required", http.StatusBadRequest)
				return
			}
			mgr := GetSpeechManager()
			if mgr == nil {
				http.Error(w, "speech-to-md not initialised", http.StatusServiceUnavailable)
				return
			}
			if b.Agent == "local" {
				if err := mgr.StartLocalSession(b.LocalModel, b.Model, b.Prompt); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
			} else {
				if err := mgr.StartSession(b.Agent, b.Model, b.Prompt); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
			}
			json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
		}
		handler(w, req)

		// Manager not initialised in test — expect 503, not 400.
		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("expected 503 when manager not initialised, got %d", w.Code)
		}
	})

	t.Run("local_model field is parsed from request body", func(t *testing.T) {
		body := `{"agent":"local","local_model":"Qwen3-35B","model":"base"}`
		req := httptest.NewRequest(http.MethodPost, "/api/speech-to-md/session/start", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()

		var parsedLocalModel string
		handler := func(w http.ResponseWriter, r *http.Request) {
			var b struct {
				Agent      string `json:"agent"`
				Model      string `json:"model"`
				LocalModel string `json:"local_model"`
			}
			json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
			parsedLocalModel = b.LocalModel
			w.WriteHeader(http.StatusOK)
		}
		handler(w, req)

		if parsedLocalModel != "Qwen3-35B" {
			t.Errorf("expected local_model 'Qwen3-35B', got %q", parsedLocalModel)
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
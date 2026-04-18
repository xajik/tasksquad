package hooks

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tasksquad/daemon/config"
)

// ── Fake Agent ────────────────────────────────────────────────────────────────

type fakeAgent struct {
	id      string
	name    string
	mode    string
	taskID  string
	learning bool
	hookMsg string

	completeCalled        bool
	stopAndPauseCalled    bool
	setWaitingInputCalled bool
	setHookMessageCalled  bool
}

func (a *fakeAgent) ID() string            { return a.id }
func (a *fakeAgent) Name() string          { return a.name }
func (a *fakeAgent) GetMode() string       { return a.mode }
func (a *fakeAgent) GetTaskID() string     { return a.taskID }
func (a *fakeAgent) IsLearning() bool      { return a.learning }
func (a *fakeAgent) SetHookMessage(m string) { a.hookMsg = m; a.setHookMessageCalled = true }

func (a *fakeAgent) Complete(_ *config.Config, _ string, _ string) {
	a.completeCalled = true
}
func (a *fakeAgent) StopAndPause(_ *config.Config, _, _ string) {
	a.stopAndPauseCalled = true
}
func (a *fakeAgent) SetWaitingInput(_ *config.Config, _, _ string) {
	a.setWaitingInputCalled = true
}
func (a *fakeAgent) PushIntermediateResponse(_ *config.Config, _, _ string) {}
func (a *fakeAgent) AdvanceCloseStep(_ *config.Config)                      {}
func (a *fakeAgent) GetLastTmuxCapture() string                             { return "" }

// ── findAndDispatch ───────────────────────────────────────────────────────────

func TestFindAndDispatch_MatchByAgentID(t *testing.T) {
	a1 := &fakeAgent{id: "agent-1", taskID: "task-1"}
	a2 := &fakeAgent{id: "agent-2", taskID: "task-2"}
	agents := []Agent{a1, a2}

	called := false
	found := findAndDispatch(agents, "agent-2", "", func(a Agent) {
		called = true
		if a.ID() != "agent-2" {
			t.Errorf("dispatched to wrong agent: %s", a.ID())
		}
	})

	if !found {
		t.Error("expected found=true")
	}
	if !called {
		t.Error("dispatch fn not called")
	}
}

func TestFindAndDispatch_MatchByTaskID(t *testing.T) {
	a := &fakeAgent{id: "agent-1", taskID: "task-xyz"}
	called := false
	found := findAndDispatch([]Agent{a}, "", "task-xyz", func(_ Agent) { called = true })

	if !found || !called {
		t.Error("expected match on task ID")
	}
}

func TestFindAndDispatch_StaleTaskIDSkipped(t *testing.T) {
	a := &fakeAgent{id: "agent-1", taskID: "current-task"}
	called := false
	found := findAndDispatch([]Agent{a}, "agent-1", "old-task", func(_ Agent) { called = true })

	if found {
		t.Error("stale task_id should not be dispatched")
	}
	if called {
		t.Error("fn should not be called for stale hook")
	}
}

func TestFindAndDispatch_NoAgentsReturnsFalse(t *testing.T) {
	found := findAndDispatch([]Agent{}, "", "", func(_ Agent) {})
	if found {
		t.Error("expected false for empty agent list")
	}
}

func TestFindAndDispatch_WildcardAgentID(t *testing.T) {
	// empty agentID matches the first agent regardless of its ID
	a := &fakeAgent{id: "any-id", taskID: ""}
	called := false
	found := findAndDispatch([]Agent{a}, "", "", func(_ Agent) { called = true })
	if !found || !called {
		t.Error("empty agentID should match first agent")
	}
}

// ── getAgentModes ─────────────────────────────────────────────────────────────

func TestGetAgentModes_Format(t *testing.T) {
	agents := []Agent{
		&fakeAgent{name: "alpha", mode: "idle"},
		&fakeAgent{name: "beta", mode: "running"},
	}
	got := getAgentModes(agents)
	if !strings.Contains(got, "alpha:idle") {
		t.Errorf("missing alpha:idle in %q", got)
	}
	if !strings.Contains(got, "beta:running") {
		t.Errorf("missing beta:running in %q", got)
	}
}

func TestGetAgentModes_Empty(t *testing.T) {
	got := getAgentModes(nil)
	if got != "" {
		t.Errorf("empty agents should give empty string, got %q", got)
	}
}

// ── writeJSON ─────────────────────────────────────────────────────────────────

func TestWriteJSON_SetsContentType(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})

	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

func TestWriteJSON_StatusCode(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad"})
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestWriteJSON_ValidBody(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, http.StatusOK, map[string]string{"key": "value"})

	var got map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON: %v — body: %s", err, w.Body.String())
	}
	if got["key"] != "value" {
		t.Errorf("got %v", got)
	}
}

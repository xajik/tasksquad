package hooks

import (
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tasksquad/daemon/config"
)

type codexTestAgent struct {
	fakeAgent
	events chan string
}

func (a *codexTestAgent) StopAndPause(_ *config.Config, message, _ string) {
	a.events <- "pause:" + message
}
func (a *codexTestAgent) AdvanceCloseStep(_ *config.Config) { a.events <- "advance" }

func TestCodexHookRouting(t *testing.T) {
	a := &codexTestAgent{fakeAgent: fakeAgent{id: "a", taskID: "t", mode: "running"}, events: make(chan string, 10)}
	b := &codexTestAgent{fakeAgent: fakeAgent{id: "b", taskID: "u", mode: "running"}, events: make(chan string, 10)}
	h := NewHandler(&config.Config{}, []Agent{a, b}, nil, nil)
	send := func(agent, task, thread, turn, kind string) {
		t.Helper()
		body := fmt.Sprintf(`{"type":%q,"thread-id":%q,"turn-id":%q,"last-assistant-message":"OK"}`, kind, thread, turn)
		r := httptest.NewRequest("POST", "/hooks/codex?agent="+agent+"&task_id="+task, strings.NewReader(body))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	expect := func(ch chan string, want string) {
		t.Helper()
		select {
		case got := <-ch:
			if got != want {
				t.Fatal(got)
			}
		case <-time.After(time.Second):
			t.Fatal("missing dispatch", want)
		}
	}
	send("a", "t", "thread-a", "1", "agent-turn-complete")
	expect(a.events, "pause:OK")
	send("a", "t", "thread-a", "1", "agent-turn-complete") // duplicate
	send("a", "stale", "thread-a", "2", "agent-turn-complete")
	send("a", "t", "wrong-thread", "2", "agent-turn-complete")
	send("a", "t", "thread-a", "2", "unrelated")
	send("b", "u", "thread-b", "1", "agent-turn-complete")
	expect(b.events, "pause:OK")
	a.mode = "wrapping_up"
	send("a", "t", "thread-a", "2", "agent-turn-complete")
	expect(a.events, "advance")
	// Reset/retry of the same task creates a new CLI thread whose turn IDs
	// can repeat. The old thread must not suppress its first response.
	a.mode = "running"
	a.pinnedSessionID = ""
	send("a", "t", "thread-restarted", "1", "agent-turn-complete")
	expect(a.events, "pause:OK")
	send("a", "t", "thread-restarted", "1", "agent-turn-complete")
	select {
	case event := <-a.events:
		t.Fatal("unexpected dispatch", event)
	case <-time.After(30 * time.Millisecond):
	}
}

func TestCodexInvalidCallbacks(t *testing.T) {
	h := NewHandler(&config.Config{}, nil, nil, nil)
	for _, tc := range []struct {
		method, url, body string
		status            int
	}{
		{"GET", "/hooks/codex", "", 405},
		{"POST", "/hooks/codex", `{}`, 400},
		{"POST", "/hooks/codex?agent=a&task_id=t", `{`, 400},
		{"POST", "/hooks/codex?agent=a&task_id=t", `{"type":"agent-turn-complete"}`, 400},
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(tc.method, tc.url, strings.NewReader(tc.body)))
		if w.Code != tc.status {
			t.Fatal(w.Code, tc)
		}
	}
}

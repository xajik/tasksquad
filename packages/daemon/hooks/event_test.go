package hooks

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/metrics"
)

func TestEventHookFeedsCurrentTaskOnly(t *testing.T) {
	a := &fakeAgent{id: "ev-agent", taskID: "cur", mode: "running"}
	h := NewHandler(&config.Config{}, []Agent{a}, nil, nil)
	send := func(task, body string) string {
		t.Helper()
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("POST", "/hooks/event?agent=ev-agent&task_id="+task, strings.NewReader(body)))
		if w.Code != 200 {
			t.Fatalf("status = %d", w.Code)
		}
		return strings.TrimSpace(w.Body.String())
	}

	// PreToolUse blocks on the reply: it must be an empty decision.
	if got := send("cur", `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"x"}`); got != "{}" {
		t.Errorf("reply = %q, want {}", got)
	}
	send("stale", `{"hook_event_name":"PreToolUse","tool_name":"Read","tool_use_id":"y"}`)

	l := metrics.Take("ev-agent", "cur")
	if l == nil || l.Tools["Bash"] == nil || l.Tools["Bash"].Calls != 1 {
		t.Fatalf("current-task lifecycle missing Bash call: %+v", l)
	}
	if l.Tools["Read"] != nil {
		t.Error("hook for a stale task was recorded")
	}
}

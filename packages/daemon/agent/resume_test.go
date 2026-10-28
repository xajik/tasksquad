package agent

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/tasksquad/daemon/config"
)

func msg(role, body string) map[string]interface{} {
	return map[string]interface{}{"role": role, "body": body}
}

func TestBuildResumePrompt(t *testing.T) {
	cases := []struct {
		name string
		msgs []interface{}
		want string
	}{
		{"only the replies after the last agent message",
			[]interface{}{msg("user", "fix the bug"), msg("agent", "which one?"), msg("user", "the login one"), msg("user", "  and add a test  ")},
			"the login one\n\nand add a test"},
		{"no unanswered message means the process died mid-turn",
			[]interface{}{msg("user", "fix the bug"), msg("agent", "done")},
			resumeInterruptedPrompt},
		{"no messages", nil, resumeInterruptedPrompt},
	}
	for _, c := range cases {
		if got := buildResumePrompt(c.msgs); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestDetachReason(t *testing.T) {
	cases := []struct {
		name                     string
		st                       AgentState
		wantDetach, wantResumeKO bool
	}{
		{"exited while waiting for input", AgentState{mode: ModeWaitingInput, sessionID: "s"}, true, false},
		{"resumed spawn died before any hook", AgentState{mode: ModeRunning, sessionID: "s", resumed: true}, true, true},
		{"resumed spawn crashed after its first hook", AgentState{mode: ModeRunning, sessionID: "s", resumed: true, cliSessionID: "c"}, false, false},
		{"fresh spawn crashed mid-turn", AgentState{mode: ModeRunning, sessionID: "s"}, false, false},
		{"already completing", AgentState{mode: ModeWaitingInput, sessionID: "s", completing: true}, false, false},
		{"closed or reset (no session)", AgentState{mode: ModeWaitingInput}, false, false},
		{"close sequence", AgentState{mode: ModeLearning, sessionID: "s"}, false, false},
	}
	for i := range cases {
		c := &cases[i]
		d, r := c.st.detachReason()
		if d != c.wantDetach || r != c.wantResumeKO {
			t.Errorf("%s: got (%v, %v), want (%v, %v)", c.name, d, r, c.wantDetach, c.wantResumeKO)
		}
	}
}

func TestResumeTarget(t *testing.T) {
	const id = "6f75c202-a633-4804-8b23-5937aa47f17f"
	root := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", root)
	claude := New(config.AgentConfig{Name: "c", Command: "claude"})
	codex := New(config.AgentConfig{Name: "x", Command: "codex"})
	task := func(prov, sid string) map[string]any {
		return map[string]any{"id": "t", "resume": map[string]any{"provider": prov, "session_id": sid}}
	}

	if got := claude.resumeTarget(task("claude-code", id)); got != "" {
		t.Fatalf("session not in the local store must not resume, got %q", got)
	}
	dir := filepath.Join(root, "projects", "p")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte("{}\n"), 0o644)

	if got := claude.resumeTarget(task("claude-code", id)); got != id {
		t.Fatalf("got %q, want %q", got, id)
	}
	if got := claude.resumeTarget(map[string]any{"id": "t"}); got != "" {
		t.Fatalf("task without resume: got %q", got)
	}
	if got := codex.resumeTarget(task("claude-code", id)); got != "" {
		t.Fatalf("a different provider's session must not resume, got %q", got)
	}
	if got := claude.resumeTarget(task("claude-code", "--help")); got != "" {
		t.Fatalf("flag-like id must not resume, got %q", got)
	}
}

func TestWithResume(t *testing.T) {
	claude := New(config.AgentConfig{Name: "c", Command: "claude"})
	if body := claude.withResume(map[string]any{}); len(body) != 0 {
		t.Fatalf("nothing pinned yet: %v", body)
	}
	claude.st.PinCLISessionID("6f75c202-a633-4804-8b23-5937aa47f17f")
	body := claude.withResume(map[string]any{"message": "hi"})
	if body["provider"] != "claude-code" || body["provider_session_id"] != "6f75c202-a633-4804-8b23-5937aa47f17f" {
		t.Fatalf("got %v", body)
	}

	claw := New(config.AgentConfig{Name: "w", Command: "agent"})
	claw.st.PinCLISessionID("abc")
	if body := claw.withResume(map[string]any{}); len(body) != 0 {
		t.Fatalf("non-resumable provider reported a session: %v", body)
	}
}

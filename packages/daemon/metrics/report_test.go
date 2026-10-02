package metrics

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestSkills(t *testing.T) {
	if got := Skills("run $tsq-cleanup then /tsq-kb-builder now"); !reflect.DeepEqual(got, []string{"tsq-cleanup", "tsq-kb-builder"}) {
		t.Fatalf("got %v", got)
	}
	if got := Skills("path/tsq-x and $5 and /other"); len(got) != 0 {
		t.Fatalf("expected none, got %v", got)
	}
}

func TestClaudeCountsUsageOncePerMessage(t *testing.T) {
	lines := []string{
		`{"message":{"id":"m1","model":"claude-opus","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":7},"content":[{"type":"tool_use","id":"t1","name":"Bash"}]}}`,
		`{"message":{"id":"m1","model":"claude-opus","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"t1","name":"Bash"}]}}`,
		`{"message":{"role":"user","content":[{"type":"tool_result","is_error":true}]}}`,
		`{"message":{"id":"m2","usage":{"input_tokens":3,"output_tokens":2},"content":[{"type":"tool_use","id":"t2","name":"Skill","input":{"skill":"tsq-end-session-memory"}},{"type":"tool_use","id":"t3","name":"Read"}]}}`,
		`not json`,
	}
	r := New("claude-code")
	Claude(lines, r)
	if r.Model != "claude-opus" || r.InputTokens != 13 || r.OutputTokens != 7 || r.CacheReadTokens != 100 || r.CacheWriteTokens != 7 {
		t.Fatalf("usage: %+v", r)
	}
	if !reflect.DeepEqual(r.Tools, map[string]int{"Bash": 1, "Skill": 1, "Read": 1}) || r.ToolErrors != 1 {
		t.Fatalf("tools: %v errors %d", r.Tools, r.ToolErrors)
	}
	if !reflect.DeepEqual(r.Skills, map[string]int{"tsq-end-session-memory": 1}) {
		t.Fatalf("skills: %v", r.Skills)
	}
}

func TestCodexUsesCumulativeTotals(t *testing.T) {
	lines := []string{
		`{"type":"turn_context","payload":{"model":"gpt-6-astra"}}`,
		`{"type":"response_item","payload":{"type":"function_call","name":"exec_command"}}`,
		`{"type":"response_item","payload":{"type":"local_shell_call"}}`,
		`{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":40}}}}`,
		`{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2000,"cached_input_tokens":1500,"cache_write_input_tokens":3,"output_tokens":90,"reasoning_output_tokens":10}}}}`,
	}
	r := New("codex")
	Codex(lines, r)
	if r.Model != "gpt-6-astra" || r.InputTokens != 500 || r.CacheReadTokens != 1500 || r.CacheWriteTokens != 3 || r.OutputTokens != 100 {
		t.Fatalf("usage: %+v", r)
	}
	if !reflect.DeepEqual(r.Tools, map[string]int{"exec_command": 1, "shell": 1}) {
		t.Fatalf("tools: %v", r.Tools)
	}
}

func TestGenericScan(t *testing.T) {
	var v any
	json.Unmarshal([]byte(`{"messages":[{"model":"gemini-3","parts":[{"functionCall":{"name":"read_file"}}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":9}},{"type":"toolCall","name":"bash"}]}`), &v) //nolint:errcheck
	r := New("gemini")
	Generic(v, r)
	if !reflect.DeepEqual(r.Tools, map[string]int{"read_file": 1, "bash": 1}) || r.InputTokens != 50 || r.OutputTokens != 9 || r.Model != "gemini-3" {
		t.Fatalf("got %+v", r)
	}
}

func TestTranscriptLocation(t *testing.T) {
	home := t.TempDir()
	codex := filepath.Join(home, ".codex", "sessions", "2026", "09", "30", "rollout-2026-09-30T10-00-00-thread-abc.jsonl")
	pi := filepath.Join(home, ".pi", "agent", "sessions", "--Users-me-project--", "s.jsonl")
	for _, p := range []string{codex, pi} {
		os.MkdirAll(filepath.Dir(p), 0o755)  //nolint:errcheck
		os.WriteFile(p, []byte("{}"), 0o644) //nolint:errcheck
	}
	since := time.Now().Add(-time.Minute)
	if got := Transcript("codex", "/Users/me/project", "", "thread-abc", since, home); got != codex {
		t.Fatalf("codex: %q", got)
	}
	if got := Transcript("pi", "/Users/me/project", "", "", since, home); got != pi {
		t.Fatalf("pi: %q", got)
	}
	if got := Transcript("pi", "/Users/me/project", "", "", time.Now().Add(time.Minute), home); got != "" {
		t.Fatalf("older transcripts must not be attributed: %q", got)
	}
	if got := Transcript("opencode", "/x", "", "", since, home); got != "" {
		t.Fatalf("opencode: %q", got)
	}
}

func TestBodyCarriesCountsOnly(t *testing.T) {
	r := New("stdout")
	r.AddSkill("tsq-x")
	b := r.Body("s1")
	if b["session_id"] != "s1" || b["tool_calls"] != 0 || !reflect.DeepEqual(b["skills"], map[string]int{"tsq-x": 1}) {
		t.Fatalf("body: %v", b)
	}
}

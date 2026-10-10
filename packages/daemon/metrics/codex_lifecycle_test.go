package metrics

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeRollout(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCodexLifecycleWithSubagent(t *testing.T) {
	home := t.TempDir()
	day := filepath.Join(home, ".codex", "sessions", "2026", "10", "10")
	main := filepath.Join(day, "rollout-a-main.jsonl")
	writeRollout(t, main,
		`{"timestamp":"2026-10-10T10:00:00.000Z","type":"session_meta","payload":{"id":"main","source":"cli"}}`,
		`{"timestamp":"2026-10-10T10:00:00.100Z","type":"event_msg","payload":{"type":"task_started"}}`,
		`{"timestamp":"2026-10-10T10:00:00.200Z","type":"turn_context","payload":{"model":"gpt-x"}}`,
		`{"timestamp":"2026-10-10T10:00:01.000Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"c1"}}`,
		`{"timestamp":"2026-10-10T10:00:01.300Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1"}}`,
		`{"timestamp":"2026-10-10T10:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"c2"}}`,
		`{"timestamp":"2026-10-10T10:00:02.050Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c2"}}`,
		`{"timestamp":"2026-10-10T10:00:03.000Z","type":"response_item","payload":{"type":"function_call","name":"apply_patch","call_id":"c3"}}`,
		`{"timestamp":"2026-10-10T10:00:04.000Z","type":"compacted","payload":{}}`,
		`{"timestamp":"2026-10-10T10:00:05.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":50}}}}`,
		`{"timestamp":"2026-10-10T10:00:09.000Z","type":"event_msg","payload":{"type":"task_complete","duration_ms":8900}}`,
		`{"timestamp":"2026-10-10T10:00:09.500Z","type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}`,
	)
	writeRollout(t, filepath.Join(day, "rollout-b-sub.jsonl"),
		`{"timestamp":"2026-10-10T10:00:02.100Z","type":"session_meta","payload":{"id":"sub","parent_thread_id":"main","source":{"subagent":{"thread_spawn":{"parent_thread_id":"main","agent_role":"explorer"}}}}}`,
		`{"timestamp":"2026-10-10T10:00:02.200Z","type":"turn_context","payload":{"model":"gpt-mini"}}`,
		`{"timestamp":"2026-10-10T10:00:02.300Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"s1"}}`,
		`{"timestamp":"2026-10-10T10:00:02.400Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"s1"}}`,
		`{"timestamp":"2026-10-10T10:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":100,"output_tokens":7}}}}`,
		`{"timestamp":"2026-10-10T10:00:03.000Z","type":"event_msg","payload":{"type":"task_complete","duration_ms":900}}`,
	)
	writeRollout(t, filepath.Join(day, "rollout-c-other.jsonl"),
		`{"timestamp":"2026-10-10T10:00:02.100Z","type":"session_meta","payload":{"id":"other","parent_thread_id":"someone-else"}}`,
		`{"timestamp":"2026-10-10T10:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":99999}}}}`,
	)

	l := CodexLifecycle(main, home, time.Now().Add(-time.Hour))
	if l == nil {
		t.Fatal("nil lifecycle")
	}
	r := New("codex")
	Read(main, "codex", r)
	l.Merge(r)

	if r.Tools["exec"] != 2 || r.Tools["spawn_agent"] != 1 || r.Tools["apply_patch"] != 1 {
		t.Errorf("tools = %v", r.Tools)
	}
	if r.InputTokens != 600+200 || r.OutputTokens != 57 || r.CacheReadTokens != 500 {
		t.Errorf("tokens in=%d out=%d cache=%d", r.InputTokens, r.OutputTokens, r.CacheReadTokens)
	}
	exec := l.Tools["exec"]
	if exec.TotalMs != 400 || exec.MaxMs != 300 || exec.Subagent != 1 {
		t.Errorf("exec = %+v", exec)
	}
	if l.Tools["apply_patch"].Unfinished != 1 {
		t.Errorf("apply_patch = %+v", l.Tools["apply_patch"])
	}
	sub := l.Subagents["explorer"]
	if sub == nil || sub.Runs != 1 || sub.TotalMs != 900 || sub.ToolCalls != 1 || sub.InputTokens != 200 || sub.Model != "gpt-mini" {
		t.Errorf("explorer = %+v", sub)
	}
	if l.ActiveMs != 8900 || l.Prompts != 1 || l.Compactions["auto"] != 1 || l.StopFailures["interrupted"] != 1 {
		t.Errorf("active=%d prompts=%d compactions=%v stops=%v", l.ActiveMs, l.Prompts, l.Compactions, l.StopFailures)
	}
	if r.Lifecycle["source"] != "transcript" {
		t.Errorf("source = %v", r.Lifecycle["source"])
	}
}

func TestCodexLifecycleMissingRollout(t *testing.T) {
	if CodexLifecycle(filepath.Join(t.TempDir(), "nope.jsonl"), t.TempDir(), time.Now()) != nil {
		t.Error("want nil for a missing rollout")
	}
}

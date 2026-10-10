package metrics

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func hook(l *Lifecycle, at time.Time, format string, args ...any) {
	l.Hook([]byte(fmt.Sprintf(format, args...)), at)
}

func TestLifecycleClaudeSession(t *testing.T) {
	dir := t.TempDir()
	transcript := filepath.Join(dir, "sess.jsonl")
	subDir := filepath.Join(dir, "sess", "subagents")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(subDir, "agent-a1.jsonl"), []byte( //nolint:errcheck
		`{"message":{"id":"m1","model":"claude-haiku-4-5","usage":{"input_tokens":100,"output_tokens":20}}}`+"\n"), 0o644)

	t0 := time.Unix(1_000, 0)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	l := newLifecycle()
	hook(l, at(0), `{"hook_event_name":"SessionStart","source":"startup","model":"claude-opus-5-5","transcript_path":%q}`, transcript)
	hook(l, at(10), `{"hook_event_name":"UserPromptSubmit","prompt":"secret prompt"}`)
	hook(l, at(20), `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"t1"}`)
	hook(l, at(999), `{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_use_id":"t1","duration_ms":200}`)
	hook(l, at(230), `{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_use_id":"t2"}`)
	hook(l, at(240), `{"hook_event_name":"PostToolUseFailure","tool_name":"Edit","tool_use_id":"t2"}`)
	hook(l, at(250), `{"hook_event_name":"PermissionDenied","tool_name":"Write","tool_use_id":"t3"}`)
	hook(l, at(300), `{"hook_event_name":"SubagentStart","agent_id":"a1","agent_type":"Explore"}`)
	hook(l, at(310), `{"hook_event_name":"PreToolUse","agent_id":"a1","tool_name":"Grep","tool_use_id":"t4","transcript_path":"/sub.jsonl"}`)
	hook(l, at(320), `{"hook_event_name":"PostToolUse","agent_id":"a1","tool_name":"Grep","tool_use_id":"t4"}`)
	hook(l, at(800), `{"hook_event_name":"SubagentStop","agent_id":"a1","agent_type":"Explore"}`)
	hook(l, at(900), `{"hook_event_name":"PreCompact","compact_reason":"auto"}`)
	hook(l, at(1000), `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"t5"}`)
	hook(l, at(1010), `{"hook_event_name":"Stop"}`)
	hook(l, at(1100), `{"hook_event_name":"SessionEnd","reason":"other"}`)
	hook(l, at(1200), `not json`)

	r := New("claude-code")
	r.InputTokens, r.Tools = 1000, map[string]int{"Bash": 1}
	l.Merge(r)

	if r.Tools["Bash"] != 2 || r.Tools["Grep"] != 1 || r.Tools["Edit"] != 1 || r.ToolErrors != 1 {
		t.Errorf("tools = %v errors = %d", r.Tools, r.ToolErrors)
	}
	if r.Turns != 1 || r.Model != "claude-opus-5-5" {
		t.Errorf("turns = %d model = %q", r.Turns, r.Model)
	}
	if r.InputTokens != 1100 || r.OutputTokens != 20 {
		t.Errorf("tokens in=%d out=%d, want subagent tokens added", r.InputTokens, r.OutputTokens)
	}
	bash := l.Tools["Bash"]
	if bash.TotalMs != 200 || bash.MaxMs != 200 || bash.Unfinished != 1 {
		t.Errorf("bash timing = %+v", bash)
	}
	if l.Tools["Write"].Denied != 1 || l.Tools["Grep"].Subagent != 1 {
		t.Errorf("write = %+v grep = %+v", l.Tools["Write"], l.Tools["Grep"])
	}
	explore := l.Subagents["Explore"]
	if explore.Runs != 1 || explore.TotalMs != 500 || explore.ToolCalls != 1 || explore.InputTokens != 100 || explore.Model != "claude-haiku-4-5" {
		t.Errorf("explore = %+v", explore)
	}
	lc := r.Lifecycle
	if lc["active_ms"] != int64(1000) || lc["end_reason"] != "other" || l.Compactions["auto"] != 1 {
		t.Errorf("lifecycle = %v", lc)
	}
	if l.TranscriptPath() != transcript {
		t.Errorf("transcript = %q, subagent path must not replace the main one", l.TranscriptPath())
	}
}

func TestLifecycleWithoutToolHooksKeepsTranscriptTools(t *testing.T) {
	l := newLifecycle()
	hook(l, time.Now(), `{"hook_event_name":"SessionStart","source":"resume"}`)
	r := New("claude-code")
	r.Tools, r.ToolErrors = map[string]int{"Read": 4}, 2
	l.Merge(r)
	if r.Tools["Read"] != 4 || r.ToolErrors != 2 {
		t.Errorf("tools = %v errors = %d", r.Tools, r.ToolErrors)
	}
}

func TestRegistryTakeDropsAgentsStaleTasks(t *testing.T) {
	Live("agentA", "old").Hook([]byte(`{"hook_event_name":"Stop"}`), time.Now())
	cur := Live("agentA", "cur")
	other := Live("agentB", "x")
	if Take("agentA", "cur") != cur {
		t.Fatal("Take returned a different lifecycle")
	}
	if Take("agentA", "old") != nil || Take("agentA", "cur") != nil {
		t.Error("stale entries for agentA survived Take")
	}
	if Take("agentB", "x") != other {
		t.Error("Take for agentA removed agentB's lifecycle")
	}
}

func TestLifecycleGeminiHooks(t *testing.T) {
	t0 := time.Unix(2_000, 0)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	l := newLifecycle()
	hook(l, at(0), `{"hook_event_name":"SessionStart","source":"startup","transcript_path":"/g/chat.json"}`)
	hook(l, at(10), `{"hook_event_name":"BeforeAgent","prompt":"secret"}`)
	hook(l, at(20), `{"hook_event_name":"BeforeModel","llm_request":{"model":"gemini-3-pro","messages":[]}}`)
	// Two overlapping read_file calls without ids pair oldest-first.
	hook(l, at(100), `{"hook_event_name":"BeforeTool","tool_name":"read_file","tool_input":{"path":"a"}}`)
	hook(l, at(150), `{"hook_event_name":"BeforeTool","tool_name":"read_file","tool_input":{"path":"b"}}`)
	hook(l, at(300), `{"hook_event_name":"AfterTool","tool_name":"read_file","tool_response":{"llmContent":"x","error":null}}`)
	hook(l, at(400), `{"hook_event_name":"AfterTool","tool_name":"read_file","tool_response":{"llmContent":"","error":"ENOENT"}}`)
	hook(l, at(500), `{"hook_event_name":"BeforeTool","tool_name":"run_shell_command"}`)
	hook(l, at(600), `{"hook_event_name":"PreCompress","trigger":"auto"}`)
	hook(l, at(1010), `{"hook_event_name":"AfterAgent","prompt_response":"secret"}`)
	hook(l, at(1100), `{"hook_event_name":"SessionEnd","reason":"exit"}`)

	r := New("gemini")
	l.Merge(r)
	rf := l.Tools["read_file"]
	if rf.Calls != 2 || rf.Errors != 1 || rf.TotalMs != 200+250 || rf.MaxMs != 250 {
		t.Errorf("read_file = %+v", rf)
	}
	if l.Tools["run_shell_command"].Unfinished != 1 {
		t.Errorf("run_shell_command = %+v", l.Tools["run_shell_command"])
	}
	if r.Tools["read_file"] != 2 || r.ToolErrors != 1 || r.Model != "gemini-3-pro" || r.Turns != 1 {
		t.Errorf("report tools=%v errors=%d model=%q turns=%d", r.Tools, r.ToolErrors, r.Model, r.Turns)
	}
	if l.ActiveMs != 1000 || l.Compactions["auto"] != 1 || l.EndReason != "exit" || l.Events["ModelRequest"] != 1 {
		t.Errorf("active=%d compactions=%v end=%q events=%v", l.ActiveMs, l.Compactions, l.EndReason, l.Events)
	}
}

func TestLifecycleOpenCodeUsageAndDuplicates(t *testing.T) {
	now := time.Unix(3_000, 0)
	l := newLifecycle()
	hook(l, now, `{"hook_event_name":"SessionStart","source":"startup"}`)
	// The plugin can be loaded twice; repeated prompts and calls count once.
	for i := 0; i < 2; i++ {
		hook(l, now, `{"hook_event_name":"UserPromptSubmit","message_id":"u1"}`)
		hook(l, now, `{"hook_event_name":"PreToolUse","tool_name":"task","tool_use_id":"c1"}`)
	}
	hook(l, now, `{"hook_event_name":"SubagentStart","agent_id":"ses_child","agent_type":"general"}`)
	hook(l, now, `{"hook_event_name":"PreToolUse","tool_name":"bash","tool_use_id":"c2","agent_id":"ses_child"}`)
	hook(l, now, `{"hook_event_name":"PostToolUse","tool_name":"bash","tool_use_id":"c2","agent_id":"ses_child","duration_ms":38}`)
	hook(l, now, `{"hook_event_name":"Usage","message_id":"m2","agent_id":"ses_child","model":"opencode/free","input_tokens":100,"output_tokens":5,"cache_read_tokens":50,"cost":0.25}`)
	hook(l, now, `{"hook_event_name":"SubagentStop","agent_id":"ses_child"}`)
	hook(l, now, `{"hook_event_name":"PostToolUse","tool_name":"task","tool_use_id":"c1","duration_ms":5611}`)
	hook(l, now, `{"hook_event_name":"Usage","message_id":"m1","model":"opencode/free","input_tokens":1000,"output_tokens":20,"cost":0.5}`)
	hook(l, now, `{"hook_event_name":"Usage","message_id":"m1","model":"opencode/free","input_tokens":1000,"output_tokens":20,"cost":0.5}`)

	r := New("opencode")
	l.Merge(r)
	if r.Turns != 1 || r.Tools["task"] != 1 || r.Tools["bash"] != 1 {
		t.Errorf("turns=%d tools=%v", r.Turns, r.Tools)
	}
	if r.InputTokens != 1100 || r.OutputTokens != 25 || r.CacheReadTokens != 50 || l.CostUSD != 0.75 {
		t.Errorf("tokens in=%d out=%d cache=%d cost=%v", r.InputTokens, r.OutputTokens, r.CacheReadTokens, l.CostUSD)
	}
	sub := l.Subagents["general"]
	if sub.InputTokens != 100 || sub.ToolCalls != 1 || sub.Model != "opencode/free" {
		t.Errorf("general = %+v", sub)
	}
	if l.Tools["task"].TotalMs != 5611 || l.Tools["task"].Unfinished != 0 {
		t.Errorf("task = %+v", l.Tools["task"])
	}
}

func TestLifecycleUsageNeverOverridesTranscriptTokens(t *testing.T) {
	l := newLifecycle()
	hook(l, time.Now(), `{"hook_event_name":"Usage","message_id":"m","input_tokens":5}`)
	r := New("claude-code")
	r.InputTokens = 900
	l.Merge(r)
	if r.InputTokens != 900 {
		t.Errorf("input = %d, transcript totals must win", r.InputTokens)
	}
}

package adapter_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/tasksquad/daemon/adapter"
)

// ── helpers ──────────────────────────────────────────────────────────────────

func writeTempFile(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	return p
}

// ── For() registry ───────────────────────────────────────────────────────────

func TestFor_KnownProviders(t *testing.T) {
	cases := []struct {
		name     string
		wantType string
	}{
		{"claude-code", "adapter.ClaudeAdapter"},
		{"claude", "adapter.ClaudeAdapter"},
		{"gemini", "adapter.GeminiAdapter"},
		{"codex", "adapter.CodexAdapter"},
		{"opencode", "adapter.OpenCodeAdapter"},
		{"stdout", "adapter.StdoutAdapter"},
		{"", "adapter.ClaudeAdapter"},          // unknown → Claude default
		{"unknown-xyz", "adapter.ClaudeAdapter"}, // unknown → Claude default
	}
	for _, tc := range cases {
		a := adapter.For(tc.name)
		if a == nil {
			t.Errorf("For(%q) returned nil", tc.name)
		}
	}
}

// ── ClaudeAdapter ─────────────────────────────────────────────────────────────

const claudeTranscript = `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"ping"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"First turn"}]}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"again"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Last turn"}]}}
{"type":"result","result":"success","total_cost_usd":0.001}
`

func TestClaudeAdapter_ParseStop_Normal(t *testing.T) {
	body := []byte(`{"stop_reason":"end_turn","transcript_path":"/tmp/t.jsonl"}`)
	ev, err := adapter.ClaudeAdapter{}.ParseStop(body, false)
	if err != nil {
		t.Fatal(err)
	}
	if ev.Reason != "end_turn" {
		t.Errorf("Reason = %q, want end_turn", ev.Reason)
	}
	if ev.TranscriptPath != "/tmp/t.jsonl" {
		t.Errorf("TranscriptPath = %q", ev.TranscriptPath)
	}
	if ev.IsFailure {
		t.Error("IsFailure should be false for end_turn")
	}
}

func TestClaudeAdapter_ParseStop_ErrorReason(t *testing.T) {
	body := []byte(`{"stop_reason":"error","transcript_path":""}`)
	ev, err := adapter.ClaudeAdapter{}.ParseStop(body, false)
	if err != nil {
		t.Fatal(err)
	}
	if !ev.IsFailure {
		t.Error("IsFailure should be true when stop_reason=error")
	}
}

func TestClaudeAdapter_ParseStop_Failure(t *testing.T) {
	body := []byte(`{"error_type":"crash","transcript_path":"/tmp/t.jsonl"}`)
	ev, err := adapter.ClaudeAdapter{}.ParseStop(body, true)
	if err != nil {
		t.Fatal(err)
	}
	if !ev.IsFailure {
		t.Error("IsFailure should be true when isFailure=true")
	}
	if ev.Reason != "crash" {
		t.Errorf("Reason = %q, want crash", ev.Reason)
	}
}

func TestClaudeAdapter_ParseNotification(t *testing.T) {
	body := []byte(`{"message":"need input","transcript_path":"/tmp/t.jsonl"}`)
	ev, err := adapter.ClaudeAdapter{}.ParseNotification(body)
	if err != nil {
		t.Fatal(err)
	}
	if ev.Message != "need input" {
		t.Errorf("Message = %q", ev.Message)
	}
}

func TestClaudeAdapter_ParseAfterAgent_Noop(t *testing.T) {
	ev, err := adapter.ClaudeAdapter{}.ParseAfterAgent([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if ev.PromptResponse != "" || ev.TranscriptPath != "" {
		t.Error("expected zero AfterAgentEvent for Claude")
	}
}

func TestClaudeAdapter_ExtractTranscript_LastTurn(t *testing.T) {
	path := writeTempFile(t, "t.jsonl", claudeTranscript)
	got := adapter.ClaudeAdapter{}.ExtractTranscript(path)
	if got != "Last turn" {
		t.Errorf("got %q, want %q", got, "Last turn")
	}
}

func TestClaudeAdapter_ExtractTranscript_Missing(t *testing.T) {
	got := adapter.ClaudeAdapter{}.ExtractTranscript("/nonexistent/path.jsonl")
	if got != "" {
		t.Errorf("expected empty string for missing file, got %q", got)
	}
}

// ── GeminiAdapter ─────────────────────────────────────────────────────────────

const geminiTranscript = `{"messages":[{"type":"user","content":"ping"},{"type":"gemini","content":"Gemini reply"}]}`
const geminiTranscriptArray = `{"messages":[{"type":"gemini","content":[{"text":"part1"},{"text":"part2"}]}]}`

func TestGeminiAdapter_ParseStop(t *testing.T) {
	body := []byte(`{"reason":"end_turn","transcript_path":"/tmp/g.json"}`)
	ev, err := adapter.GeminiAdapter{}.ParseStop(body, false)
	if err != nil {
		t.Fatal(err)
	}
	if ev.Reason != "end_turn" {
		t.Errorf("Reason = %q", ev.Reason)
	}
	if ev.IsFailure {
		t.Error("IsFailure should be false")
	}
}

func TestGeminiAdapter_ParseStop_ErrorReason(t *testing.T) {
	body := []byte(`{"reason":"error","transcript_path":""}`)
	ev, _ := adapter.GeminiAdapter{}.ParseStop(body, false)
	if !ev.IsFailure {
		t.Error("IsFailure should be true when reason=error")
	}
}

func TestGeminiAdapter_ParseAfterAgent(t *testing.T) {
	body := []byte(`{"prompt_response":"per-turn text","transcript_path":"/tmp/g.json"}`)
	ev, err := adapter.GeminiAdapter{}.ParseAfterAgent(body)
	if err != nil {
		t.Fatal(err)
	}
	if ev.PromptResponse != "per-turn text" {
		t.Errorf("PromptResponse = %q", ev.PromptResponse)
	}
}

func TestGeminiAdapter_ExtractTranscript_String(t *testing.T) {
	path := writeTempFile(t, "t.json", geminiTranscript)
	got := adapter.GeminiAdapter{}.ExtractTranscript(path)
	if got != "Gemini reply" {
		t.Errorf("got %q, want %q", got, "Gemini reply")
	}
}

func TestGeminiAdapter_ExtractTranscript_ArrayContent(t *testing.T) {
	path := writeTempFile(t, "t.json", geminiTranscriptArray)
	got := adapter.GeminiAdapter{}.ExtractTranscript(path)
	if got != "part1\npart2" {
		t.Errorf("got %q, want %q", got, "part1\npart2")
	}
}

// ── OpenCodeAdapter ───────────────────────────────────────────────────────────

func TestOpenCodeAdapter_ParseStop_HookMessage(t *testing.T) {
	body := []byte(`{"stop_reason":"end_turn","message":"Clean response","transcript_path":"/tmp/oc.json"}`)
	ev, err := adapter.OpenCodeAdapter{}.ParseStop(body, false)
	if err != nil {
		t.Fatal(err)
	}
	if ev.HookMessage != "Clean response" {
		t.Errorf("HookMessage = %q, want %q", ev.HookMessage, "Clean response")
	}
	if ev.IsFailure {
		t.Error("IsFailure should be false")
	}
}

func TestOpenCodeAdapter_ParseAfterAgent_Noop(t *testing.T) {
	ev, err := adapter.OpenCodeAdapter{}.ParseAfterAgent([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if ev.PromptResponse != "" {
		t.Error("expected zero AfterAgentEvent for OpenCode")
	}
}

func TestOpenCodeAdapter_ExtractTranscript_DelegatesGemini(t *testing.T) {
	// OpenCode transcript is Gemini-compatible JSON format
	content := `{"messages":[{"type":"assistant","content":"DONE"}]}`
	path := writeTempFile(t, "t.json", content)
	got := adapter.OpenCodeAdapter{}.ExtractTranscript(path)
	if got != "DONE" {
		t.Errorf("got %q, want DONE", got)
	}
}

// ── CodexAdapter ──────────────────────────────────────────────────────────────

func TestCodexAdapter_ParseStop_Normal_Noop(t *testing.T) {
	// Codex normal completion goes via /hooks/codex, not /hooks/stop
	ev, err := adapter.CodexAdapter{}.ParseStop([]byte(`{}`), false)
	if err != nil {
		t.Fatal(err)
	}
	if ev.IsFailure || ev.Reason != "" || ev.TranscriptPath != "" {
		t.Errorf("expected zero StopEvent for Codex normal stop, got %+v", ev)
	}
}

func TestCodexAdapter_ParseStop_Failure(t *testing.T) {
	body := []byte(`{"error_type":"crash","transcript_path":""}`)
	ev, err := adapter.CodexAdapter{}.ParseStop(body, true)
	if err != nil {
		t.Fatal(err)
	}
	if !ev.IsFailure {
		t.Error("IsFailure should be true")
	}
	if ev.Reason != "crash" {
		t.Errorf("Reason = %q, want crash", ev.Reason)
	}
}

func TestCodexAdapter_ExtractTranscript_AlwaysEmpty(t *testing.T) {
	got := adapter.CodexAdapter{}.ExtractTranscript("/any/path")
	if got != "" {
		t.Errorf("Codex should never return transcript text, got %q", got)
	}
}

// ── StdoutAdapter ─────────────────────────────────────────────────────────────

func TestStdoutAdapter_AllNoops(t *testing.T) {
	a := adapter.StdoutAdapter{}
	if ev, _ := a.ParseStop(nil, false); ev != (adapter.StopEvent{}) {
		t.Error("StopEvent should be zero")
	}
	if ev, _ := a.ParseNotification(nil); ev != (adapter.NotificationEvent{}) {
		t.Error("NotificationEvent should be zero")
	}
	if ev, _ := a.ParseAfterAgent(nil); ev != (adapter.AfterAgentEvent{}) {
		t.Error("AfterAgentEvent should be zero")
	}
	if got := a.ExtractTranscript("/any"); got != "" {
		t.Errorf("ExtractTranscript should be empty, got %q", got)
	}
}

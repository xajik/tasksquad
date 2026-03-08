package agent

import (
	"os"
	"path/filepath"
	"testing"
)

// sampleTranscript is a minimal Claude Code JSONL transcript with one
// user turn followed by one assistant turn.
const sampleTranscript = `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly one word: DONE"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"DONE"}]}}
{"type":"result","result":"success","total_cost_usd":0.001}
`

// multiTurnTranscript has two assistant turns; we should return the last one.
const multiTurnTranscript = `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"What is 2+2?"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"2+2 equals 4."}]}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"And 3+3?"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"3+3 equals 6."}]}}
`

func writeTranscript(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "transcript.jsonl")
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatalf("write transcript: %v", err)
	}
	return p
}

func TestExtractTranscriptResponse_Basic(t *testing.T) {
	path := writeTranscript(t, sampleTranscript)
	got := ExtractTranscriptResponse(path)

	const input = "Reply with exactly one word: DONE"
	if got == "" {
		t.Fatal("response is empty")
	}
	if got == input {
		t.Errorf("response equals input %q — agent did not produce a distinct reply", input)
	}
	t.Logf("agent response: %q", got)
}

func TestExtractTranscriptResponse_MultiTurn_ReturnsLast(t *testing.T) {
	path := writeTranscript(t, multiTurnTranscript)
	got := ExtractTranscriptResponse(path)

	if got != "3+3 equals 6." {
		t.Errorf("expected last assistant turn, got %q", got)
	}
}

func TestExtractTranscriptResponse_MissingFile(t *testing.T) {
	got := ExtractTranscriptResponse("/nonexistent/path/transcript.jsonl")
	if got != "" {
		t.Errorf("expected empty string for missing file, got %q", got)
	}
}

func TestExtractTranscriptResponse_EmptyFile(t *testing.T) {
	path := writeTranscript(t, "")
	got := ExtractTranscriptResponse(path)
	if got != "" {
		t.Errorf("expected empty string for empty transcript, got %q", got)
	}
}

func TestBuildNotifyMessage_FiltersPrompt(t *testing.T) {
	a := &Agent{
		lastPrompt: "Translate into ukrainian: I love you my motherland",
		outputLines: []string{
			"> Translate into ukrainian: I love you my motherland",
			"I will translate that for you. Is that okay?",
		},
	}

	got := buildNotifyMessage(a, "fallback")
	expected := "I will translate that for you. Is that okay?"

	if got != expected {
		t.Errorf("expected %q, got %q", expected, got)
	}
}

func TestBuildNotifyMessage_FallbackWhenAllFiltered(t *testing.T) {
	a := &Agent{
		lastPrompt: "Hello",
		outputLines: []string{
			"Hello",
		},
	}

	got := buildNotifyMessage(a, "fallback")
	expected := "fallback"

	if got != expected {
		t.Errorf("expected %q, got %q", expected, got)
	}
}

package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildConversationPrompt_NoMessages(t *testing.T) {
	got := buildConversationPrompt("fix the bug", nil, "")
	if got != "fix the bug" {
		t.Errorf("got %q, want %q", got, "fix the bug")
	}
}

func TestBuildConversationPrompt_EmptySlice(t *testing.T) {
	got := buildConversationPrompt("subject", []interface{}{}, "")
	if got != "subject" {
		t.Errorf("got %q, want subject", got)
	}
}

func TestBuildConversationPrompt_SingleMessage(t *testing.T) {
	msgs := []interface{}{
		map[string]interface{}{"role": "user", "body": "hello"},
	}
	got := buildConversationPrompt("fallback", msgs, "")
	if got != "hello" {
		t.Errorf("got %q, want %q", got, "hello")
	}
}

func TestBuildConversationPrompt_SingleMessageEmptyBody(t *testing.T) {
	msgs := []interface{}{
		map[string]interface{}{"role": "user", "body": ""},
	}
	got := buildConversationPrompt("fallback", msgs, "")
	if got != "fallback" {
		t.Errorf("single message with empty body should fall back to subject, got %q", got)
	}
}

func TestBuildConversationPrompt_MultiTurn(t *testing.T) {
	msgs := []interface{}{
		map[string]interface{}{"role": "user", "body": "Hello"},
		map[string]interface{}{"role": "agent", "body": "Hi there"},
		map[string]interface{}{"role": "user", "body": "How are you?"},
	}
	got := buildConversationPrompt("unused", msgs, "")
	if want := "Human: Hello\n\nAssistant: Hi there\n\nHuman: How are you?"; got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestBuildConversationPrompt_MultiTurnUnknownRoleSkipped(t *testing.T) {
	msgs := []interface{}{
		map[string]interface{}{"role": "system", "body": "ignored"},
		map[string]interface{}{"role": "user", "body": "question"},
	}
	got := buildConversationPrompt("unused", msgs, "")
	if want := "Human: question"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// ── memoryRollup ────────────────────────────────────────────────────────────

func TestBuildConversationPrompt_RollupAbsent_PromptUnchanged(t *testing.T) {
	msgs := []interface{}{
		map[string]interface{}{"role": "user", "body": "hello"},
	}
	got := buildConversationPrompt("fallback", msgs, "")
	if got != "hello" {
		t.Errorf("empty rollup must not alter the base prompt: got %q", got)
	}
}

func TestBuildConversationPrompt_RollupPresent_Prepended(t *testing.T) {
	msgs := []interface{}{
		map[string]interface{}{"role": "user", "body": "hello"},
	}
	rollup := "- Migrated auth to Firebase\n- Renamed /widgets to /components"
	got := buildConversationPrompt("fallback", msgs, rollup)

	want := "## Project memory (recent activity)\n" + rollup + "\n\n---\n\nhello"
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestBuildConversationPrompt_RollupPresent_NoMessages(t *testing.T) {
	rollup := "Team shipped Portals this week."
	got := buildConversationPrompt("fix the bug", nil, rollup)

	want := "## Project memory (recent activity)\n" + rollup + "\n\n---\n\nfix the bug"
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
	if !strings.HasPrefix(got, "## Project memory") {
		t.Errorf("rollup section must lead the prompt, got:\n%s", got)
	}
}

func TestBuildConversationPrompt_RollupPresent_MultiTurn(t *testing.T) {
	msgs := []interface{}{
		map[string]interface{}{"role": "user", "body": "Hello"},
		map[string]interface{}{"role": "agent", "body": "Hi there"},
	}
	rollup := "Daily summary content."
	got := buildConversationPrompt("unused", msgs, rollup)

	want := "## Project memory (recent activity)\nDaily summary content.\n\n---\n\nHuman: Hello\n\nAssistant: Hi there"
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

// ── injectKBNote ────────────────────────────────────────────────────────────

func TestInjectKBNote_NoKB_PromptUnchanged(t *testing.T) {
	workDir := t.TempDir()
	got := injectKBNote("hello", workDir)
	if got != "hello" {
		t.Errorf("expected prompt unchanged with no tsq/kb, got %q", got)
	}
}

func TestInjectKBNote_EmptyKBDir_PromptUnchanged(t *testing.T) {
	workDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workDir, "tsq", "kb"), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	got := injectKBNote("hello", workDir)
	if got != "hello" {
		t.Errorf("expected prompt unchanged for an empty tsq/kb dir, got %q", got)
	}
}

func TestInjectKBNote_KBExists_AppendsBlock(t *testing.T) {
	workDir := t.TempDir()
	kbDir := filepath.Join(workDir, "tsq", "kb")
	if err := os.MkdirAll(kbDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(kbDir, "example.md"), []byte("---\ntitle: Example\n---\n\nbody"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	got := injectKBNote("hello", workDir)
	if !strings.HasPrefix(got, "hello\n\n## Knowledge base available") {
		t.Errorf("expected KB note appended after original prompt, got:\n%s", got)
	}
	if !strings.Contains(got, "tsq kb search") {
		t.Errorf("expected KB note to mention `tsq kb search`, got:\n%s", got)
	}
}

func TestInjectKBNote_IndependentOfMemoryRollup(t *testing.T) {
	workDir := t.TempDir()
	kbDir := filepath.Join(workDir, "tsq", "kb")
	if err := os.MkdirAll(kbDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(kbDir, "example.md"), []byte("body"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	// No memoryRollup passed to buildConversationPrompt (team Memory absent
	// or disabled) — the KB note must still be appended, since kb.Exists is
	// a purely local, per-checkout check unrelated to team Memory settings.
	base := buildConversationPrompt("fallback", nil, "")
	got := injectKBNote(base, workDir)
	if !strings.Contains(got, "## Knowledge base available") {
		t.Errorf("expected KB note even with memoryRollup empty, got:\n%s", got)
	}
}

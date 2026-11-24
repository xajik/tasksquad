package agent

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/tasksquad/daemon/provider"
)

func TestGraphAgentArgs(t *testing.T) {
	dir := t.TempDir()
	task := map[string]any{"graph": map[string]any{"role": "grade"}}
	claude := &provider.ClaudeCode{}
	if got := graphAgentArgs(claude, task, dir); got != nil {
		t.Fatalf("sub-agent not installed must fall back, got %v", got)
	}
	if err := os.MkdirAll(filepath.Join(dir, ".claude", "agents"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"tsq-graph-grader", "tsq-graph-executor", "tsq-graph-planner", "tsq-graph-agent"} {
		if err := os.WriteFile(filepath.Join(dir, ".claude", "agents", name+".md"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	cases := map[string][]string{
		"grade": {"--agent", "tsq-graph-grader"}, "project": {"--agent", "tsq-graph-grader"},
		"execute": {"--agent", "tsq-graph-executor"}, "undo": {"--agent", "tsq-graph-executor"}, "continue": {"--agent", "tsq-graph-executor"},
		"plan": {"--agent", "tsq-graph-planner"}, "merge": {"--agent", "tsq-graph-planner"}, "decompose": {"--agent", "tsq-graph-planner"},
		"repair": {"--agent", "tsq-graph-agent"}, "reconcile": {"--agent", "tsq-graph-agent"},
	}
	for role, want := range cases {
		got := graphAgentArgs(claude, map[string]any{"graph": map[string]any{"role": role}}, dir)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %v want %v", role, got, want)
		}
	}
	if got := graphAgentArgs(&provider.Codex{}, task, dir); got != nil {
		t.Fatalf("only Claude Code uses sub-agents, got %v", got)
	}
	if got := graphAgentArgs(claude, map[string]any{}, dir); got != nil {
		t.Fatalf("non-graph task got %v", got)
	}
}

func TestGraphIdentityText(t *testing.T) {
	dir := t.TempDir()
	task := map[string]any{"graph": map[string]any{"role": "execute"}}
	if got := graphIdentityText(task, dir); got != "" {
		t.Fatalf("nothing installed, got %q", got)
	}
	if err := os.MkdirAll(filepath.Join(dir, ".agents", "agents"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := "---\nname: tsq-graph-executor\n---\n# Identity\nYou execute one step."
	if err := os.WriteFile(filepath.Join(dir, ".agents", "agents", "tsq-graph-executor.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, want := graphIdentityText(task, dir), "# Identity\nYou execute one step."; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	if got := graphIdentityText(map[string]any{"graph": map[string]any{"role": "merge"}}, dir); got != "" {
		t.Fatalf("merge has no identity, got %q", got)
	}
}

func TestGraphIdentityTextTruncatesOnRuneBoundary(t *testing.T) {
	dir := t.TempDir()
	task := map[string]any{"graph": map[string]any{"role": "execute"}}
	if err := os.MkdirAll(filepath.Join(dir, ".agents", "agents"), 0o755); err != nil {
		t.Fatal(err)
	}
	// 3-byte runes: the 1600-byte cut lands inside a character unless handled.
	body := strings.Repeat("é€", 900)
	if err := os.WriteFile(filepath.Join(dir, ".agents", "agents", "tsq-graph-executor.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	got := graphIdentityText(task, dir)
	if !utf8.ValidString(got) || !strings.HasSuffix(got, "…") {
		t.Fatalf("expected valid truncated text ending in an ellipsis, got %q", got)
	}
}

func TestGraphIdentityTextPrefersClaudeDirectory(t *testing.T) {
	dir := t.TempDir()
	task := map[string]any{"graph": map[string]any{"role": "execute"}}
	for base, text := range map[string]string{".claude": "from claude", ".agents": "from agents"} {
		if err := os.MkdirAll(filepath.Join(dir, base, "agents"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, base, "agents", "tsq-graph-executor.md"), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if got := graphIdentityText(task, dir); got != "from claude" {
		t.Fatalf("got %q", got)
	}
}

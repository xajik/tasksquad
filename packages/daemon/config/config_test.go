package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultPath_ContainsDotTasksquad(t *testing.T) {
	p := DefaultPath()
	if !strings.Contains(p, ".tasksquad") {
		t.Errorf("DefaultPath() = %q, expected it to contain .tasksquad", p)
	}
	if !strings.HasSuffix(p, "config.toml") {
		t.Errorf("DefaultPath() = %q, expected suffix config.toml", p)
	}
}

func TestLoad_NotFound(t *testing.T) {
	_, err := Load("/nonexistent/path/config.toml")
	if err == nil {
		t.Error("expected error for missing config file")
	}
	if !strings.Contains(err.Error(), "config file not found") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestLoad_NoAgents(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	os.WriteFile(path, []byte(`[server]
url = "https://example.com"
`), 0644)

	_, err := Load(path)
	if err == nil {
		t.Error("expected error when no agents defined")
	}
	if !strings.Contains(err.Error(), "agents") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestLoad_AgentMissingID(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	os.WriteFile(path, []byte(`[[agents]]
name = "my-agent"
command = "claude"
work_dir = "/tmp"
`), 0644)

	_, err := Load(path)
	if err == nil {
		t.Error("expected error for agent missing id")
	}
	if !strings.Contains(err.Error(), "id is required") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestLoad_ValidMinimal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	os.WriteFile(path, []byte(`[[agents]]
id = "agent-abc"
name = "my-agent"
command = "claude"
work_dir = "/tmp"
`), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cfg.Agents) != 1 {
		t.Fatalf("expected 1 agent, got %d", len(cfg.Agents))
	}
	if cfg.Agents[0].ID != "agent-abc" {
		t.Errorf("ID = %q", cfg.Agents[0].ID)
	}
}

func TestLoad_DefaultsApplied(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	os.WriteFile(path, []byte(`[[agents]]
id = "agent-abc"
name = "test"
command = "claude"
work_dir = "/tmp"
`), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Defaults should supply a server URL and poll interval.
	if cfg.Server.URL == "" {
		t.Error("server URL should have a default value")
	}
	if cfg.Server.PollInterval <= 0 {
		t.Error("poll interval should have a positive default")
	}
}

func TestLoad_HomeTildeExpanded(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	os.WriteFile(path, []byte(`[[agents]]
id = "agent-abc"
name = "test"
command = "claude"
work_dir = "~/Projects"
`), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.HasPrefix(cfg.Agents[0].WorkDir, "~") {
		t.Errorf("tilde not expanded: %q", cfg.Agents[0].WorkDir)
	}
}

func TestExpandHome_NoTilde(t *testing.T) {
	got := expandHome("/absolute/path")
	if got != "/absolute/path" {
		t.Errorf("got %q, want /absolute/path", got)
	}
}

func TestExpandHome_WithTilde(t *testing.T) {
	got := expandHome("~/foo/bar")
	home, _ := os.UserHomeDir()
	want := filepath.Join(home, "foo/bar")
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestDefaultDir_ContainsDotTasksquad(t *testing.T) {
	d := DefaultDir()
	if !strings.Contains(d, ".tasksquad") {
		t.Errorf("DefaultDir() = %q, expected it to contain .tasksquad", d)
	}
	if strings.HasSuffix(d, "config.toml") {
		t.Errorf("DefaultDir() = %q, should not end with config.toml", d)
	}
}

func TestLoad_SupervisorAbsent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	os.WriteFile(path, []byte(`[[agents]]
id = "agent-abc"
name = "test"
command = "claude"
work_dir = "/tmp"
`), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Supervisor != nil {
		t.Errorf("expected Supervisor to be nil when section is absent, got %+v", cfg.Supervisor)
	}
}

func TestLoad_SupervisorPresent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	os.WriteFile(path, []byte(`[[agents]]
id = "agent-abc"
name = "test"
command = "claude"
work_dir = "/tmp"

[supervisor]
command = "opencode -m ollama/gemma4:26b"
`), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Supervisor == nil {
		t.Fatal("expected Supervisor to be non-nil when section is present")
	}
	if cfg.Supervisor.Command != "opencode -m ollama/gemma4:26b" {
		t.Errorf("Command = %q, want %q", cfg.Supervisor.Command, "opencode -m ollama/gemma4:26b")
	}
}

func TestLoad_SupervisorEmptyCommand(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	os.WriteFile(path, []byte(`[[agents]]
id = "agent-abc"
name = "test"
command = "claude"
work_dir = "/tmp"

[supervisor]
command = ""
`), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Supervisor == nil {
		t.Fatal("expected Supervisor to be non-nil (section present, command empty)")
	}
	if cfg.Supervisor.Command != "" {
		t.Errorf("expected empty Command, got %q", cfg.Supervisor.Command)
	}
}

func TestLoad_IsSupervisorFlagIgnored(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	// Old config with is_supervisor flag — should load without error (unknown fields ignored).
	os.WriteFile(path, []byte(`[[agents]]
id = "agent-abc"
name = "test"
command = "claude"
work_dir = "/tmp"
is_supervisor = true
`), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("unexpected error loading old config with is_supervisor: %v", err)
	}
	if cfg.Supervisor != nil {
		t.Errorf("old is_supervisor flag should not populate Supervisor section, got %+v", cfg.Supervisor)
	}
}

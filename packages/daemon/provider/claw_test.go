package provider

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

type clawSettings struct {
	Model string `toml:"model"`
	Hooks []struct {
		Event    string `toml:"event"`
		ToolName string `toml:"tool_name"`
		Action   struct {
			Type string `toml:"type"`
			URL  string `toml:"url"`
		} `toml:"action"`
	} `toml:"hooks"`
}

func readClawSettings(t *testing.T, dir string) (clawSettings, string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, ".agent", "settings.local.toml"))
	if err != nil {
		t.Fatal(err)
	}
	var s clawSettings
	if _, err := toml.Decode(string(data), &s); err != nil {
		t.Fatalf("settings.local.toml is not valid TOML: %v\n%s", err, data)
	}
	return s, string(data)
}

func TestClawSetupWritesTOMLStopHook(t *testing.T) {
	dir := t.TempDir()
	if err := (&Claw{}).Setup(dir, 7374, "agent-123", "task-456"); err != nil {
		t.Fatal(err)
	}
	s, _ := readClawSettings(t, dir)
	var stops []string
	for _, h := range s.Hooks {
		if h.Event == "stop" {
			stops = append(stops, h.Action.URL)
		}
		if h.Action.Type != "http" {
			t.Errorf("hook %s has action type %q", h.Event, h.Action.Type)
		}
	}
	if len(stops) != 1 || stops[0] != "http://localhost:7374/hooks/stop?agent=agent-123&task_id=task-456" {
		t.Errorf("stop hooks = %v", stops)
	}
	if _, err := os.Stat(filepath.Join(dir, ".agent", "settings.json")); err == nil {
		t.Error("settings.json is never read by agent-code and must not be written")
	}
}

func TestClawSetupReplacesItsBlockAndKeepsUserSettings(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".agent", "settings.local.toml")
	os.MkdirAll(filepath.Dir(path), 0o755)                  //nolint:errcheck
	os.WriteFile(path, []byte(`model = "my-model"`), 0o644) //nolint:errcheck

	(&Claw{}).Setup(dir, 7374, "a", "old-task") //nolint:errcheck
	if err := (&Claw{}).Setup(dir, 7374, "a", "new-task"); err != nil {
		t.Fatal(err)
	}
	s, raw := readClawSettings(t, dir)
	if s.Model != "my-model" {
		t.Errorf("user setting lost: model = %q", s.Model)
	}
	if strings.Contains(raw, "old-task") || strings.Count(raw, clawManagedStart) != 1 {
		t.Errorf("previous task's block not replaced:\n%s", raw)
	}
}

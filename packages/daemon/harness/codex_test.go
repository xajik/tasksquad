package harness

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

func TestCodexAgentLifecycle(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".codex", "agents", "tsq-test.toml")
	for _, body := range []string{"first", "updated \"quotes\"\nsecond line"} {
		if err := InstallCodexAgent(dir, "tsq-test", "test description", "---\nname: other\n---\n"+body); err != nil {
			t.Fatal(err)
		}
		var cfg map[string]string
		if _, err := toml.DecodeFile(path, &cfg); err != nil {
			t.Fatal(err)
		}
		if cfg["developer_instructions"] != body || cfg["name"] != "tsq-test" {
			t.Fatal(cfg)
		}
	}
	RemoveCodexAgent(dir, "tsq-test")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("managed file not removed")
	}
	if err := os.WriteFile(path, []byte("user-authored"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := InstallCodexAgent(dir, "tsq-test", "new", "new"); err != nil {
		t.Fatal(err)
	}
	RemoveCodexAgent(dir, "tsq-test")
	data, _ := os.ReadFile(path)
	if string(data) != "user-authored" {
		t.Fatal("user agent changed")
	}
	if err := InstallCodexAgent(dir, "../escape", "bad", "bad"); err == nil {
		t.Fatal("unsafe name accepted")
	}
}

func TestCodexCommandLifecycle(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".agents", "skills", "source-command-tsq-test", "SKILL.md")
	for _, body := range []string{"first", "updated"} {
		if err := InstallCodexCommand(dir, "tsq-test", body); err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(path)
		if !strings.Contains(string(data), body) {
			t.Fatal("command not installed")
		}
	}
	RemoveCodexCommand(dir, "tsq-test")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("command not removed")
	}
	os.WriteFile(path, []byte("personal skill"), 0600)
	InstallCodexCommand(dir, "tsq-test", "overwrite")
	RemoveCodexCommand(dir, "tsq-test")
	data, _ := os.ReadFile(path)
	if string(data) != "personal skill" {
		t.Fatal("personal skill changed")
	}
}

func TestRepositoryCodexAgents(t *testing.T) {
	files, err := filepath.Glob("../../../.codex/agents/*.toml")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 6 {
		t.Fatalf("expected six native agents, got %d", len(files))
	}
	for _, path := range files {
		var cfg map[string]any
		if _, err := toml.DecodeFile(path, &cfg); err != nil {
			t.Fatal(path, err)
		}
		for _, field := range []string{"name", "description", "developer_instructions"} {
			if value, ok := cfg[field].(string); !ok || value == "" {
				t.Fatal(path, field)
			}
		}
		if strings.Contains(cfg["developer_instructions"].(string), ".Codex/") {
			t.Fatal("invalid case-sensitive path", path)
		}
	}
}

func TestCodexSkillPreservesUserFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".agents", "skills", "tsq-example", "SKILL.md")
	for _, body := range []string{"first", "updated"} {
		if err := InstallCodexSkill(dir, "tsq-example", "---\nname: tsq-example\ndescription: Example\n---\n"+body); err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(path)
		if !strings.HasPrefix(string(data), "---\n") || !strings.Contains(string(data), body) {
			t.Fatal(string(data))
		}
	}
	RemoveCodexSkill(dir, "tsq-example")
	os.WriteFile(path, []byte("personal"), 0600)
	InstallCodexSkill(dir, "tsq-example", "replacement")
	RemoveCodexSkill(dir, "tsq-example")
	data, _ := os.ReadFile(path)
	if string(data) != "personal" {
		t.Fatal("personal skill changed")
	}
}

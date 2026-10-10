package provider

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenCodePluginReportsLifecycle(t *testing.T) {
	dir := t.TempDir()
	if err := (&OpenCode{}).Setup(dir, 7374, "agent-123", "task-456"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, ".opencode", "plugins", "tasksquad.ts"))
	if err != nil {
		t.Fatal(err)
	}
	plugin := string(data)
	for _, want := range []string{
		`"/hooks/event?agent=agent-123&task_id=task-456&provider=opencode"`,
		`"/hooks/stop?agent=agent-123&task_id=task-456&provider=opencode"`,
		"analytics(event)", `emit("Usage"`, `emit("SubagentStart"`, `emit("PreToolUse"`,
	} {
		if !strings.Contains(plugin, want) {
			t.Errorf("plugin missing %s", want)
		}
	}
	if strings.Contains(plugin, "@analytics") || strings.Contains(plugin, "%!") {
		t.Error("plugin has an unexpanded template marker")
	}

	// The plugin is plain JavaScript in a .ts file; syntax-check it when node exists.
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	js := filepath.Join(dir, "plugin.mjs")
	os.WriteFile(js, data, 0o644) //nolint:errcheck
	if out, err := exec.Command(node, "--check", js).CombinedOutput(); err != nil {
		t.Errorf("plugin is not valid JavaScript: %v\n%s", err, out)
	}
}

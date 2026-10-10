package provider

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPiExtensionReportsLifecycle(t *testing.T) {
	dir := t.TempDir()
	if err := (&Pi{}).Setup(dir, 7374, "agent-123", "task-456"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, ".pi", "extensions", "tasksquad.ts"))
	if err != nil {
		t.Fatal(err)
	}
	ext := string(data)
	for _, want := range []string{
		`"http://localhost:7374" + path`,
		`"/hooks/event?agent=agent-123&task_id=task-456&provider=pi"`,
		`"/hooks/stop?agent=agent-123&task_id=task-456&provider=pi"`,
		`pi.on("tool_execution_start"`, `pi.on("tool_execution_end"`, `emit("Usage"`, `pi.on("session_shutdown"`,
	} {
		if !strings.Contains(ext, want) {
			t.Errorf("extension missing %s", want)
		}
	}
	if strings.Contains(ext, "%!") {
		t.Error("extension has a formatting error")
	}
	// The daemon collects analytics when the stop hook completes the task.
	if flush, stop := strings.Index(ext, "await lifecycleQueue"), strings.Index(ext, `"/hooks/stop?`); flush < 0 || flush > stop {
		t.Error("analytics must be flushed before the stop hook is posted")
	}

	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	js := filepath.Join(dir, "ext.mjs")
	os.WriteFile(js, data, 0o644) //nolint:errcheck
	if out, err := exec.Command(node, "--check", js).CombinedOutput(); err != nil {
		t.Errorf("extension is not valid JavaScript: %v\n%s", err, out)
	}
}

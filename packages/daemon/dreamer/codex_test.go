package dreamer

import (
	"strings"
	"testing"
)

func TestCodexPrintMode(t *testing.T) {
	cmd := printModeCmd("/usr/local/bin/codex", "codex -m selected-model", "/tmp/prompt with spaces", "/tmp/log with spaces", "/tmp/bin with spaces")
	for _, want := range []string{"codex -m selected-model exec", "-c notify=[]", "'/tmp/prompt with spaces'", "'/tmp/log with spaces'", "PATH='/tmp/bin with spaces'"} {
		if !strings.Contains(cmd, want) {
			t.Errorf("missing %q in %s", want, cmd)
		}
	}
	if strings.Contains(cmd, "--dangerously") {
		t.Error("Codex sandbox bypassed")
	}
}

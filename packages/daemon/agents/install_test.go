package agents

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInstallAgent_RejectsEscapingName(t *testing.T) {
	root := t.TempDir()
	workDir := filepath.Join(root, "project")

	if err := installAgent(workDir, remoteAgent{Name: "../../../escaped", Content: "x"}); err == nil {
		t.Fatal("installAgent accepted an escaping name")
	}
	if _, err := os.Stat(filepath.Join(root, "escaped.md")); !os.IsNotExist(err) {
		t.Errorf("escaping name wrote outside the work dir: %v", err)
	}
}

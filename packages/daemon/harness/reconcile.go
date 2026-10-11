package harness

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
)

// ReconcileFile repairs missing copies without replacing user-authored content.
// previous is the canonical content before this sync, nil for a fresh install.
func ReconcileFile(destination string, content, previous []byte) error {
	old, err := os.ReadFile(destination)
	if err == nil && !bytes.Equal(old, content) && (previous == nil || !bytes.Equal(old, previous)) {
		return fmt.Errorf("resource conflict at %s; preserving local content", destination)
	}
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
		return err
	}
	return os.WriteFile(destination, content, 0644)
}

func RemoveMatchingFile(destination string, previous []byte) {
	if previous == nil {
		return
	}
	if old, err := os.ReadFile(destination); err == nil && bytes.Equal(old, previous) {
		_ = os.Remove(destination)
	}
}

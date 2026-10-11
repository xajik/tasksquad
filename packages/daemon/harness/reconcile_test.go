package harness

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReconcilePreservesConflictsAndRepairsMissingCopies(t *testing.T) {
	path := filepath.Join(t.TempDir(), "provider", "SKILL.md")
	if err := ReconcileFile(path, []byte("one"), nil); err != nil {
		t.Fatal(err)
	}
	if err := ReconcileFile(path, []byte("two"), []byte("one")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("mine"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := ReconcileFile(path, []byte("three"), []byte("two")); err == nil {
		t.Fatal("expected conflict")
	}
	RemoveMatchingFile(path, []byte("two"))
	if got, _ := os.ReadFile(path); string(got) != "mine" {
		t.Fatal("user content changed")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := ReconcileFile(path, []byte("two"), []byte("two")); err != nil {
		t.Fatal(err)
	}
	RemoveMatchingFile(path, []byte("two"))
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("managed copy not removed")
	}
}

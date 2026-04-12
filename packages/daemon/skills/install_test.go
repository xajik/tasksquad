package skills

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/tasksquad/daemon/harness"
)

func TestInstallSkill_WritesFile(t *testing.T) {
	workDir := t.TempDir()
	skill := remoteSkill{Name: "tsq-example", Content: "step 1\nstep 2"}

	if err := installSkill(workDir, skill); err != nil {
		t.Fatalf("installSkill error: %v", err)
	}

	mdPath := filepath.Join(workDir, ".tsq", "skills", "tsq-example", "SKILL.md")
	data, err := os.ReadFile(mdPath)
	if err != nil {
		t.Fatalf("SKILL.md not found: %v", err)
	}
	if string(data) != "step 1\nstep 2" {
		t.Errorf("content = %q, want %q", data, "step 1\nstep 2")
	}
}

func TestInstallSkill_CreatesSymlinks(t *testing.T) {
	workDir := t.TempDir()
	skill := remoteSkill{Name: "tsq-link-test", Content: "content"}

	if err := installSkill(workDir, skill); err != nil {
		t.Fatalf("installSkill error: %v", err)
	}

	for _, dir := range []string{".claude/skills", ".agents/skills"} {
		link := filepath.Join(workDir, dir, "tsq-link-test")
		if _, err := os.Lstat(link); err != nil {
			t.Errorf("symlink missing at %s: %v", link, err)
		}
	}
}

func TestRemoveSkill_DeletesFiles(t *testing.T) {
	workDir := t.TempDir()
	skill := remoteSkill{Name: "tsq-bye", Content: "content"}

	if err := installSkill(workDir, skill); err != nil {
		t.Fatalf("install: %v", err)
	}

	removeSkill(workDir, "tsq-bye")

	tsqDir := filepath.Join(workDir, ".tsq", "skills", "tsq-bye")
	if _, err := os.Stat(tsqDir); !os.IsNotExist(err) {
		t.Error("skill directory should be removed")
	}
}

func TestSkillDir(t *testing.T) {
	got := skillDir("/work", "tsq-foo")
	want := "/work/.tsq/skills/tsq-foo"
	if got != want {
		t.Errorf("skillDir = %q, want %q", got, want)
	}
}

func TestFileExists(t *testing.T) {
	f, err := os.CreateTemp("", "test-*.txt")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	defer os.Remove(f.Name())

	if !harness.FileExists(f.Name()) {
		t.Error("expected fileExists=true for existing file")
	}
	if harness.FileExists("/nonexistent/file.txt") {
		t.Error("expected fileExists=false for missing file")
	}
}

func TestLoadSaveLock(t *testing.T) {
	// Use a temp work dir so lockPath hashes to a unique temp file.
	workDir := t.TempDir()

	lock := loadLock(workDir)
	if len(lock) != 0 {
		t.Error("fresh lock should be empty")
	}

	lock["tsq-foo"] = "etag-abc"
	saveLock(workDir, lock)

	reloaded := loadLock(workDir)
	if reloaded["tsq-foo"] != "etag-abc" {
		t.Errorf("reloaded etag = %q, want etag-abc", reloaded["tsq-foo"])
	}
}

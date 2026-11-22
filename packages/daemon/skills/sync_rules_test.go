package skills

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func etagOf(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestInstallSkill_OverridesLocalEdits(t *testing.T) {
	wd := t.TempDir()
	lock := skillsLock{}
	v1 := remoteSkill{Name: "tsq-foo", Content: "server v1", Etag: etagOf("server v1")}
	if err := installSkill(wd, v1, lock); err != nil {
		t.Fatal(err)
	}
	claude := filepath.Join(wd, ".claude", "skills", "tsq-foo", "SKILL.md")
	write(t, claude, "user edit")
	write(t, filepath.Join(skillDir(wd, "tsq-foo"), "SKILL.md"), "user edit")

	v2 := remoteSkill{Name: "tsq-foo", Content: "server v2", Etag: etagOf("server v2")}
	if err := installSkill(wd, v2, lock); err != nil {
		t.Fatal(err)
	}
	if got := read(t, claude); got != "server v2" {
		t.Errorf("provider copy = %q, want server v2 (user edit must be overridden)", got)
	}
	if got := read(t, filepath.Join(skillDir(wd, "tsq-foo"), "SKILL.md")); got != "server v2" {
		t.Errorf("canonical copy = %q", got)
	}
}

func TestInSync_DetectsEditAndMissingCopies(t *testing.T) {
	wd := t.TempDir()
	s := remoteSkill{Name: "tsq-foo", Content: "body", Etag: etagOf("body")}
	if inSync(wd, "tsq-foo", s.Etag) {
		t.Fatal("nothing installed: must not be in sync")
	}
	if err := installSkill(wd, s, skillsLock{}); err != nil {
		t.Fatal(err)
	}
	if !inSync(wd, "tsq-foo", s.Etag) {
		t.Fatal("fresh install must be in sync")
	}
	if inSync(wd, "tsq-foo", "") {
		t.Error("unknown etag must force a refetch")
	}
	write(t, filepath.Join(wd, ".gemini", "skills", "tsq-foo", "SKILL.md"), "edited")
	if inSync(wd, "tsq-foo", s.Etag) {
		t.Error("edited provider copy must be detected")
	}
	if err := installSkill(wd, s, skillsLock{}); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(filepath.Join(wd, ".claude", "skills", "tsq-foo", "SKILL.md"))
	if inSync(wd, "tsq-foo", s.Etag) {
		t.Error("deleted provider copy must be detected")
	}
}

func TestRemoveSkill_DeletesEditedServerSkillButKeepsCustom(t *testing.T) {
	wd := t.TempDir()
	s := remoteSkill{Name: "tsq-foo", Content: "body", Etag: etagOf("body")}
	if err := installSkill(wd, s, skillsLock{}); err != nil {
		t.Fatal(err)
	}
	claude := filepath.Join(wd, ".claude", "skills", "tsq-foo", "SKILL.md")
	write(t, claude, "user edit") // edited copy of a server skill: still removed
	custom := filepath.Join(wd, ".claude", "skills", "my-own", "SKILL.md")
	write(t, custom, "mine")

	removeSkill(wd, "tsq-foo")

	if _, err := os.Stat(claude); !os.IsNotExist(err) {
		t.Error("server-managed skill must be deleted even when edited")
	}
	if _, err := os.Stat(skillDir(wd, "tsq-foo")); !os.IsNotExist(err) {
		t.Error("canonical copy must be deleted")
	}
	if read(t, custom) != "mine" {
		t.Error("custom user skill must never be touched")
	}
}

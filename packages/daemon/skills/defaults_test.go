package skills

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestStepSkillName(t *testing.T) {
	cases := map[string]string{
		"/tsq-cleanup":                      "tsq-cleanup",
		"  /tsq-end-session-learning  ":     "tsq-end-session-learning",
		"$tsq-memory extra words":           "tsq-memory",
		"tsq-cleanup":                       "",
		"":                                  "",
		"/":                                 "",
		"/../etc/passwd":                    "",
		"please run /tsq-cleanup afterward": "",
	}
	for in, want := range cases {
		if got := StepSkillName(in); got != want {
			t.Errorf("StepSkillName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEnsureDefaults_InstallsMissingOnly(t *testing.T) {
	workDir := t.TempDir()
	t.Setenv("HOME", t.TempDir())

	got, err := EnsureDefaults(workDir, []string{"tsq-cleanup"})
	if err != nil || !reflect.DeepEqual(got, []string{"tsq-cleanup"}) {
		t.Fatalf("EnsureDefaults = %v, %v", got, err)
	}
	for _, rel := range []string{".tsq/skills/tsq-cleanup/SKILL.md", ".claude/skills/tsq-cleanup/SKILL.md"} {
		if _, err := os.Stat(filepath.Join(workDir, rel)); err != nil {
			t.Errorf("%s missing after install: %v", rel, err)
		}
	}

	// A second call is a no-op and must not rewrite an edited copy.
	edited := filepath.Join(workDir, ".tsq", "skills", "tsq-cleanup", "SKILL.md")
	if err := os.WriteFile(edited, []byte("edited"), 0644); err != nil {
		t.Fatal(err)
	}
	got, err = EnsureDefaults(workDir, []string{"tsq-cleanup"})
	if err != nil || len(got) != 0 {
		t.Fatalf("second EnsureDefaults = %v, %v; want nothing installed", got, err)
	}
	if body, _ := os.ReadFile(edited); string(body) != "edited" {
		t.Errorf("existing skill was overwritten: %q", body)
	}
}

func TestEnsureDefaults_SkipsSkillAlreadyInProviderDir(t *testing.T) {
	workDir := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	dir := filepath.Join(workDir, ".claude", "skills", "tsq-cleanup")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("mine"), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := EnsureDefaults(workDir, []string{"tsq-cleanup"})
	if err != nil || len(got) != 0 {
		t.Fatalf("EnsureDefaults = %v, %v; want nothing installed", got, err)
	}
}

func TestEnsureDefaults_DoesNotTouchSyncLock(t *testing.T) {
	workDir := t.TempDir()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if _, err := EnsureDefaults(workDir, nil); err != nil {
		t.Fatal(err)
	}
	if lock := loadLock(workDir); len(lock) != 0 {
		t.Errorf("sync lock must stay empty (next sync would delete lock entries the server does not list), got %v", lock)
	}
	for _, name := range DefaultNames() {
		if !Installed(workDir, name) {
			t.Errorf("default %q not installed", name)
		}
	}
}

func TestEnsureDefaults_UnknownName(t *testing.T) {
	got, err := EnsureDefaults(t.TempDir(), []string{"tsq-nope"})
	if err == nil || len(got) != 0 {
		t.Errorf("EnsureDefaults(unknown) = %v, %v; want an error", got, err)
	}
}

func TestEnsureStepSkills_OnlyInstallsDefaultsNamedBySteps(t *testing.T) {
	workDir := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	got := EnsureStepSkills(workDir, []string{"/tsq-end-session-learning", "/not-a-default", "/tsq-cleanup", "free text"})
	want := []string{"tsq-end-session-learning", "tsq-cleanup"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("EnsureStepSkills = %v, want %v", got, want)
	}
	if Installed(workDir, "not-a-default") {
		t.Error("non-default skill must not be installed")
	}
	if Installed(workDir, "tsq-supervisor") {
		t.Error("default not named by a step must not be installed")
	}
}

func TestCloseStepDefaultsAreBuiltIn(t *testing.T) {
	for _, name := range CloseStepDefaults() {
		if !IsDefault(name) {
			t.Errorf("close-step default %q is not embedded", name)
		}
	}
}

// The embedded copies must match the catalog the worker publishes.
func TestEmbeddedDefaultsMatchWorkerCatalog(t *testing.T) {
	dir := filepath.Join("..", "..", "worker", "resources", "defaults")
	if _, err := os.Stat(dir); err != nil {
		t.Skip("worker defaults not available in this checkout")
	}
	for _, name := range DefaultNames() {
		want, err := os.ReadFile(filepath.Join(dir, name+".md"))
		if err != nil {
			t.Errorf("embedded default %q has no counterpart in worker/resources/defaults: %v", name, err)
			continue
		}
		got, _ := defaultFS.ReadFile("defaults/" + name + ".md")
		if string(got) != string(want) {
			t.Errorf("embedded default %q differs from worker/resources/defaults/%s.md; copy it over", name, name)
		}
	}
}

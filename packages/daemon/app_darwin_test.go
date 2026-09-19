package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDaemonLockRejectsSecondInstanceAndReleases(t *testing.T) {
	dir := t.TempDir()
	release, err := acquireDaemonLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if second, err := acquireDaemonLock(dir); err == nil {
		second()
		t.Fatal("second daemon acquired the lock")
	}
	release()
	third, err := acquireDaemonLock(dir)
	if err != nil {
		t.Fatalf("lock not released: %v", err)
	}
	third()
}

func TestAppBundle(t *testing.T) {
	for executable, want := range map[string]string{
		"/Applications/TaskSquad.app/Contents/MacOS/TaskSquad": "/Applications/TaskSquad.app",
		"/Applications/TaskSquad.app/Contents/MacOS/tsq":       "/Applications/TaskSquad.app",
		"/opt/homebrew/bin/tsq":                                "",
		"/tmp/NotAnApp/Contents/MacOS/tsq":                     "",
	} {
		if got := appBundle(executable); got != want {
			t.Errorf("appBundle(%q) = %q, want %q", executable, got, want)
		}
	}
}

func TestAppSearchPathFindsBundledCLIAndBrew(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "TaskSquad.app", "Contents", "MacOS")
	os.MkdirAll(bin, 0755)
	os.WriteFile(filepath.Join(bin, "tsq"), []byte("#!/bin/sh\n"), 0755)
	path := appSearchPath(filepath.Join(bin, "TaskSquad"), dir, "/usr/bin:/bin:/usr/bin:.:relative")
	t.Setenv("PATH", path)
	if got, err := exec.LookPath("tsq"); err != nil || got != filepath.Join(bin, "tsq") {
		t.Fatalf("bundled tsq not found: %q, %v", got, err)
	}
	for _, want := range []string{"/opt/homebrew/bin", "/usr/local/bin", filepath.Join(dir, ".local/bin")} {
		if !strings.Contains(":"+path+":", ":"+want+":") {
			t.Errorf("missing %s in %s", want, path)
		}
	}
	if strings.Count(path, "/usr/bin") != 1 || strings.Contains(path, ":.:") || strings.Contains(path, "relative") {
		t.Errorf("unsafe or duplicate search path: %s", path)
	}
}

func TestSetupCommandQuotesPathsAndStopsOnFailure(t *testing.T) {
	dir := t.TempDir()
	executable := filepath.Join(dir, "Task Squad's $(touch bad)")
	// A failing wizard must not launch the real app. Log argv to verify quoting.
	if err := os.WriteFile(executable, []byte("#!/bin/sh\nprintf '%s' \"$1\" > \"$TSQ_SETUP_ARGS\"\nexit 17\n"), 0700); err != nil {
		t.Fatal(err)
	}
	args := filepath.Join(dir, "args")
	t.Setenv("TSQ_SETUP_ARGS", args)
	script := filepath.Join(dir, "setup.command")
	os.WriteFile(script, []byte(setupCommand(executable, "/nonexistent.app")), 0700)
	err := exec.Command("/bin/sh", script).Run()
	if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 17 {
		t.Fatalf("wizard failure not preserved: %v", err)
	}
	got, _ := os.ReadFile(args)
	if string(got) != "init" {
		t.Fatalf("argv = %q", got)
	}
	if _, err := os.Stat(script); !os.IsNotExist(err) {
		t.Fatal("setup script was not cleaned up")
	}
}

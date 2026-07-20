package dreamer

import (
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/tasksquad/daemon/config"
)

// ── resolveDreamerCLI ───────────────────────────────────────────────────────

func TestResolveDreamerCLI_ExplicitDreamerCommand(t *testing.T) {
	cfg := &config.Config{Dreamer: &config.DreamerConfig{Command: "sh"}}
	cli, fullCmd := resolveDreamerCLI(cfg)
	if cli == "" {
		t.Fatal("expected non-empty cli for explicit dreamer.command")
	}
	if fullCmd != "sh" {
		t.Errorf("fullCmd = %q, want %q", fullCmd, "sh")
	}
}

func TestResolveDreamerCLI_FallsBackToSupervisor(t *testing.T) {
	cfg := &config.Config{
		Dreamer:    nil,
		Supervisor: &config.SupervisorConfig{Command: "sh -c echo"},
	}
	cli, fullCmd := resolveDreamerCLI(cfg)
	if cli == "" {
		t.Fatal("expected fallback to supervisor.command to resolve a cli")
	}
	if fullCmd != "sh -c echo" {
		t.Errorf("fullCmd = %q, want %q", fullCmd, "sh -c echo")
	}
}

func TestResolveDreamerCLI_EmptyDreamerCommandFallsBackToSupervisor(t *testing.T) {
	cfg := &config.Config{
		Dreamer:    &config.DreamerConfig{Command: ""},
		Supervisor: &config.SupervisorConfig{Command: "sh"},
	}
	cli, _ := resolveDreamerCLI(cfg)
	if cli == "" {
		t.Fatal("expected an empty dreamer.command to fall back to supervisor.command")
	}
}

func TestResolveDreamerCLI_BothAbsent_Disabled(t *testing.T) {
	cfg := &config.Config{Dreamer: nil, Supervisor: nil}
	cli, fullCmd := resolveDreamerCLI(cfg)
	if cli != "" || fullCmd != "" {
		t.Errorf("expected empty strings when both sections are absent, got cli=%q fullCmd=%q", cli, fullCmd)
	}
}

func TestResolveDreamerCLI_DreamerCommandWinsOverSupervisor(t *testing.T) {
	shPath, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh not available")
	}
	cfg := &config.Config{
		Dreamer:    &config.DreamerConfig{Command: "sh -c dreamer"},
		Supervisor: &config.SupervisorConfig{Command: "sh -c supervisor"},
	}
	cli, fullCmd := resolveDreamerCLI(cfg)
	if cli != shPath {
		t.Errorf("cli = %q, want %q", cli, shPath)
	}
	if fullCmd != "sh -c dreamer" {
		t.Errorf("fullCmd = %q, want the explicit dreamer.command, got %q", fullCmd, "sh -c dreamer")
	}
}

func TestResolveDreamerCLI_NotInPath_Disabled(t *testing.T) {
	cfg := &config.Config{Dreamer: &config.DreamerConfig{Command: "no-such-binary-xyz-99999"}}
	cli, fullCmd := resolveDreamerCLI(cfg)
	if cli != "" || fullCmd != "" {
		t.Errorf("expected empty strings for missing binary, got cli=%q fullCmd=%q", cli, fullCmd)
	}
}

// ── triggerTime ─────────────────────────────────────────────────────────────

func TestTriggerTime_StableForSameAgentAndDate(t *testing.T) {
	first := triggerTime("agent-1", "2026-07-13", "01:00", "05:00")
	second := triggerTime("agent-1", "2026-07-13", "01:00", "05:00")
	if !first.Equal(second) {
		t.Errorf("expected the same (agentID, date) to yield a stable instant, got %v and %v", first, second)
	}
}

func TestTriggerTime_DiffersByDate(t *testing.T) {
	day1 := triggerTime("agent-1", "2026-07-13", "01:00", "05:00")
	day2 := triggerTime("agent-1", "2026-07-14", "01:00", "05:00")
	if day1.Equal(day2) {
		t.Errorf("expected different dates to (almost certainly) yield different instants, both were %v", day1)
	}
}

func TestTriggerTime_DiffersByAgent(t *testing.T) {
	a1 := triggerTime("agent-1", "2026-07-13", "01:00", "05:00")
	a2 := triggerTime("agent-2", "2026-07-13", "01:00", "05:00")
	if a1.Equal(a2) {
		t.Errorf("expected different agent IDs to (almost certainly) yield different instants, both were %v", a1)
	}
}

func TestTriggerTime_WithinWindow(t *testing.T) {
	for _, agentID := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		got := triggerTime(agentID, "2026-07-13", "01:00", "05:00")
		start := time.Date(2026, 7, 13, 1, 0, 0, 0, time.Local)
		end := time.Date(2026, 7, 13, 5, 0, 0, 0, time.Local)
		if got.Before(start) || !got.Before(end) {
			t.Errorf("triggerTime(%q) = %v, want within [%v, %v)", agentID, got, start, end)
		}
	}
}

func TestTriggerTime_DefaultsOnEmptyWindow(t *testing.T) {
	got := triggerTime("agent-1", "2026-07-13", "", "")
	start := time.Date(2026, 7, 13, 1, 0, 0, 0, time.Local)
	end := time.Date(2026, 7, 13, 5, 0, 0, 0, time.Local)
	if got.Before(start) || !got.Before(end) {
		t.Errorf("triggerTime with empty window = %v, want within default [%v, %v)", got, start, end)
	}
}

func TestTriggerTime_RestartWithinSameDayDoesNotReroll(t *testing.T) {
	// Simulates a daemon restart mid-night: calling triggerTime again later
	// the same day for the same agent must return the exact same instant,
	// not a freshly rerolled one.
	instants := make(map[time.Time]bool)
	for i := 0; i < 5; i++ {
		instants[triggerTime("agent-restart", "2026-07-13", "01:00", "05:00")] = true
	}
	if len(instants) != 1 {
		t.Errorf("expected exactly one distinct instant across repeated calls, got %d", len(instants))
	}
}

// ── resolveProjectKey ───────────────────────────────────────────────────────

func TestResolveProjectKey_NoRemote(t *testing.T) {
	workDir := t.TempDir()
	if err := exec.Command("git", "-C", workDir, "init").Run(); err != nil {
		t.Skip("git not available")
	}

	key, err := resolveProjectKey(workDir)
	if err != nil {
		t.Fatalf("resolveProjectKey: %v", err)
	}
	if key != "" {
		t.Errorf("expected empty key for a repo with no remote, got %q", key)
	}
}

func TestResolveProjectKey_NotAGitRepo(t *testing.T) {
	workDir := t.TempDir()
	key, err := resolveProjectKey(workDir)
	if err != nil {
		t.Fatalf("resolveProjectKey: %v", err)
	}
	if key != "" {
		t.Errorf("expected empty key outside a git repo, got %q", key)
	}
}

func TestResolveProjectKey_StripsGitSuffixAndLowercases(t *testing.T) {
	workDir := t.TempDir()
	if err := exec.Command("git", "-C", workDir, "init").Run(); err != nil {
		t.Skip("git not available")
	}
	remote := "https://GitHub.com/TaskSquad/Repo.git"
	if err := exec.Command("git", "-C", workDir, "remote", "add", "origin", remote).Run(); err != nil {
		t.Fatalf("git remote add: %v", err)
	}

	key, err := resolveProjectKey(workDir)
	if err != nil {
		t.Fatalf("resolveProjectKey: %v", err)
	}
	want := "https://github.com/tasksquad/repo"
	if key != want {
		t.Errorf("key = %q, want %q", key, want)
	}
}

func TestResolveProjectKey_NoGitSuffixLeftAsIs(t *testing.T) {
	workDir := t.TempDir()
	if err := exec.Command("git", "-C", workDir, "init").Run(); err != nil {
		t.Skip("git not available")
	}
	remote := "git@github.com:TaskSquad/Repo"
	if err := exec.Command("git", "-C", workDir, "remote", "add", "origin", remote).Run(); err != nil {
		t.Fatalf("git remote add: %v", err)
	}

	key, err := resolveProjectKey(workDir)
	if err != nil {
		t.Fatalf("resolveProjectKey: %v", err)
	}
	want := "git@github.com:tasksquad/repo"
	if key != want {
		t.Errorf("key = %q, want %q", key, want)
	}
}

// ── hasRunToday / writeLastRun ──────────────────────────────────────────────

func TestHasRunToday_FalseWhenNoMarker(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if hasRunToday("agent-x", "2026-07-13") {
		t.Error("expected false with no marker file written")
	}
}

func TestWriteLastRun_ThenHasRunTodayTrue(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeLastRun("agent-x", "2026-07-13")
	if !hasRunToday("agent-x", "2026-07-13") {
		t.Error("expected true after writing today's marker")
	}
	if hasRunToday("agent-x", "2026-07-14") {
		t.Error("expected false for a different date than the one written")
	}
}

// ── safeSessionName ─────────────────────────────────────────────────────────

func TestSafeSessionName_ValidID(t *testing.T) {
	name, err := safeSessionName("tsq-dream-", "a1b2c3d4")
	if err != nil {
		t.Fatalf("safeSessionName: %v", err)
	}
	if name != "tsq-dream-a1b2c3d4" {
		t.Errorf("name = %q, want %q", name, "tsq-dream-a1b2c3d4")
	}
}

func TestSafeSessionName_RejectsUnsafeID(t *testing.T) {
	for _, bad := range []string{"", "has space", `has"quote`, "has;semicolon", strings.Repeat("a", 33)} {
		if _, err := safeSessionName("tsq-dream-", bad); err == nil {
			t.Errorf("expected safeSessionName to reject %q", bad)
		}
	}
}

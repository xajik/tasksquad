package supervisor

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tasksquad/daemon/config"
)

func TestResolveSupervisorCLI_EmptyCommand(t *testing.T) {
	cli, fullCmd := resolveSupervisorCLI(&config.SupervisorConfig{Command: ""})
	if cli != "" || fullCmd != "" {
		t.Errorf("expected empty strings for empty command, got cli=%q fullCmd=%q", cli, fullCmd)
	}
}

func TestResolveSupervisorCLI_NotInPath(t *testing.T) {
	cli, fullCmd := resolveSupervisorCLI(&config.SupervisorConfig{Command: "no-such-binary-xyz-99999"})
	if cli != "" || fullCmd != "" {
		t.Errorf("expected empty strings for missing binary, got cli=%q fullCmd=%q", cli, fullCmd)
	}
}

func TestResolveSupervisorCLI_ValidBinary(t *testing.T) {
	// "sh" is available on all Unix systems.
	cli, fullCmd := resolveSupervisorCLI(&config.SupervisorConfig{Command: "sh"})
	if cli == "" {
		t.Fatal("expected non-empty cli for 'sh'")
	}
	if fullCmd != "sh" {
		t.Errorf("fullCmd = %q, want %q", fullCmd, "sh")
	}
}

func TestResolveSupervisorCLI_CommandWithFlags(t *testing.T) {
	// Binary is "sh", flags are "-c echo".
	cli, fullCmd := resolveSupervisorCLI(&config.SupervisorConfig{Command: "sh -c echo"})
	if cli == "" {
		t.Fatal("expected non-empty cli for 'sh -c echo'")
	}
	if fullCmd != "sh -c echo" {
		t.Errorf("fullCmd = %q, want %q", fullCmd, "sh -c echo")
	}
	if strings.Contains(cli, " ") {
		t.Errorf("cli (resolved path) should not contain spaces, got %q", cli)
	}
}

func TestPrintModeCmd_ClaudeBranch(t *testing.T) {
	cmd := printModeCmd("/usr/bin/claude", "claude", "/tmp/prompt", "/tmp/log", "/usr/local/bin")
	if !strings.Contains(cmd, "-p --dangerously-skip-permissions") {
		t.Errorf("claude branch should use print-mode flags, got: %s", cmd)
	}
	if strings.Contains(cmd, "curl") {
		t.Errorf("claude branch should not contain fallback curl, got: %s", cmd)
	}
}

func TestPrintModeCmd_NonClaudeBranch_UsesFullCmd(t *testing.T) {
	fullCmd := "opencode -m ollama/gemma4:26b"
	cmd := printModeCmd("/usr/bin/opencode", fullCmd, "/tmp/prompt", "/tmp/log", "")
	if !strings.Contains(cmd, fullCmd) {
		t.Errorf("non-claude branch should use full command %q, got: %s", fullCmd, cmd)
	}
	if strings.Contains(cmd, "curl") {
		t.Errorf("non-claude branch should not contain fallback curl, got: %s", cmd)
	}
}

func TestPrintModeCmd_PathPrefix(t *testing.T) {
	cmd := printModeCmd("/usr/bin/opencode", "opencode", "/tmp/p", "/tmp/l", "/custom/bin")
	if !strings.HasPrefix(cmd, "PATH=/custom/bin:$PATH ") {
		t.Errorf("expected PATH prefix, got: %s", cmd)
	}
}

func TestPrintModeCmd_NoPathPrefix(t *testing.T) {
	cmd := printModeCmd("/usr/bin/opencode", "opencode", "/tmp/p", "/tmp/l", "")
	if strings.HasPrefix(cmd, "PATH=") {
		t.Errorf("expected no PATH prefix when daemonBinDir is empty, got: %s", cmd)
	}
}

func TestBuildContextBlock_ImageSnapshot(t *testing.T) {
	block := buildContextBlock("coder", "01TASK", "tsq-01TASK", "/logs/x.log", "/tmp/troubleshoot.md", "/tmp/01TASK-snapshot.png", true)
	if !strings.Contains(block, "Terminal screenshot") {
		t.Errorf("expected image-mode label, got: %s", block)
	}
	if !strings.Contains(block, "View this image with your Read tool") {
		t.Errorf("expected Read-tool instruction for image snapshot, got: %s", block)
	}
	if !strings.Contains(block, "/tmp/01TASK-snapshot.png") {
		t.Errorf("expected snapshot path embedded in block, got: %s", block)
	}
}

func TestBuildContextBlock_TextFallback(t *testing.T) {
	block := buildContextBlock("coder", "01TASK", "tsq-01TASK", "/logs/x.log", "/tmp/troubleshoot.md", "raw pane text here", false)
	if !strings.Contains(block, "Terminal snapshot (last 50 lines") {
		t.Errorf("expected text-mode label, got: %s", block)
	}
	if !strings.Contains(block, "raw pane text here") {
		t.Errorf("expected fallback text embedded in block, got: %s", block)
	}
	if strings.Contains(block, "Terminal screenshot") {
		t.Errorf("text fallback should not use the image-mode label, got: %s", block)
	}
}

func TestBuildContextBlock_NoSession(t *testing.T) {
	block := buildContextBlock("coder", "01TASK", "", "", "/tmp/troubleshoot.md", "", false)
	if !strings.Contains(block, "(none — session may have crashed)") {
		t.Errorf("expected crashed-session placeholder, got: %s", block)
	}
	if !strings.Contains(block, "(session not available)") {
		t.Errorf("expected snapshot placeholder, got: %s", block)
	}
}

func TestCaptureSnapshot_EmptySession(t *testing.T) {
	content, isImage := captureSnapshot("", t.TempDir()+"/sup.log", "01TASK")
	if content != "" || isImage {
		t.Errorf("expected empty/false for empty session, got content=%q isImage=%v", content, isImage)
	}
}

func TestCaptureSnapshot_RealSessionWritesPNG(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	session := "tsq-sup-test-snapshot"
	exec.Command("tmux", "kill-session", "-t", session).Run() //nolint:errcheck
	if err := exec.Command("tmux", "new-session", "-d", "-s", session).Run(); err != nil {
		t.Fatalf("failed to start tmux session: %v", err)
	}
	defer exec.Command("tmux", "kill-session", "-t", session).Run() //nolint:errcheck

	supDir := t.TempDir()
	supLog := filepath.Join(supDir, "sup.log")
	content, isImage := captureSnapshot(session, supLog, "01TASK")
	if !isImage {
		t.Fatalf("expected a real tmux session to produce an image snapshot, got text: %q", content)
	}
	wantPath := filepath.Join(supDir, "01TASK-snapshot.png")
	if content != wantPath {
		t.Errorf("snapshot path = %q, want %q", content, wantPath)
	}
	info, err := os.Stat(content)
	if err != nil {
		t.Fatalf("expected snapshot PNG to exist on disk: %v", err)
	}
	if info.Size() == 0 {
		t.Errorf("expected non-empty PNG file")
	}
	data, err := os.ReadFile(content)
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if len(data) < 8 || string(data[1:4]) != "PNG" {
		t.Errorf("snapshot file does not look like a PNG: %s", fmt.Sprintf("%x", data[:min(8, len(data))]))
	}
}

func TestCaptureSnapshot_NonexistentSessionFallsBackToText(t *testing.T) {
	supLog := filepath.Join(t.TempDir(), "sup.log")
	// No real tmux session by this name exists, so screenshot.Capture must
	// error and captureSnapshot must fall back to the (empty) text path
	// rather than panic or return a bogus image path.
	content, isImage := captureSnapshot("tsq-nonexistent-session-xyz", supLog, "01TASK")
	if isImage {
		t.Errorf("expected fallback to text mode for a nonexistent session")
	}
	if content != "" {
		t.Errorf("expected empty text fallback for a nonexistent session, got %q", content)
	}
}

func TestSafeIDRe(t *testing.T) {
	valid := []string{
		"01JQZF3XKBP5TYNQWN6KV3M8AZ", // typical ULID
		"abc123",
		"ABC-def_123",
		"a",
		"01234567890123456789012345678901", // 32 chars
	}
	for _, id := range valid {
		if !safeIDRe.MatchString(id) {
			t.Errorf("expected %q to be accepted", id)
		}
	}

	invalid := []string{
		"",
		"has space",
		`has"quote`,
		"has;semicolon",
		"has&ampersand",
		"has|pipe",
		"has`backtick",
		"has$dollar",
		"has(paren",
		"has\nnewline",
		"123456789012345678901234567890123", // 33 chars — over limit
	}
	for _, id := range invalid {
		if safeIDRe.MatchString(id) {
			t.Errorf("expected %q to be rejected", id)
		}
	}
}

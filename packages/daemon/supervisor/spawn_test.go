package supervisor

import (
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
	cmd := printModeCmd("/usr/bin/claude", "claude", "/tmp/prompt", "/tmp/log", "/usr/local/bin", "task01", 7374)
	if !strings.Contains(cmd, "-p --dangerously-skip-permissions") {
		t.Errorf("claude branch should use print-mode flags, got: %s", cmd)
	}
	if strings.Contains(cmd, "curl") {
		t.Errorf("claude branch should not contain fallback curl, got: %s", cmd)
	}
}

func TestPrintModeCmd_NonClaudeBranch_UsesFullCmd(t *testing.T) {
	fullCmd := "opencode -m ollama/gemma4:26b"
	cmd := printModeCmd("/usr/bin/opencode", fullCmd, "/tmp/prompt", "/tmp/log", "", "task01", 7374)
	if !strings.Contains(cmd, fullCmd) {
		t.Errorf("non-claude branch should use full command %q, got: %s", fullCmd, cmd)
	}
	if !strings.Contains(cmd, "curl") {
		t.Errorf("non-claude branch should contain fallback curl, got: %s", cmd)
	}
}

func TestPrintModeCmd_PathPrefix(t *testing.T) {
	cmd := printModeCmd("/usr/bin/opencode", "opencode", "/tmp/p", "/tmp/l", "/custom/bin", "task01", 7374)
	if !strings.HasPrefix(cmd, "PATH=/custom/bin:$PATH ") {
		t.Errorf("expected PATH prefix, got: %s", cmd)
	}
}

func TestPrintModeCmd_NoPathPrefix(t *testing.T) {
	cmd := printModeCmd("/usr/bin/opencode", "opencode", "/tmp/p", "/tmp/l", "", "task01", 7374)
	if strings.HasPrefix(cmd, "PATH=") {
		t.Errorf("expected no PATH prefix when daemonBinDir is empty, got: %s", cmd)
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

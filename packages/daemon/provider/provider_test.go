package provider

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestDetect_ByBinaryName(t *testing.T) {
	cases := []struct {
		command  string
		wantName string
	}{
		{"claude", "claude-code"},
		{"/usr/local/bin/claude", "claude-code"},
		{"gemini", "gemini"},
		{"/home/user/.local/bin/gemini", "gemini"},
		{"opencode", "opencode"},
		{"codex", "codex"},
		{"stdout", "stdout"},
	}
	for _, tc := range cases {
		p := Detect(tc.command, "")
		if p.Name() != tc.wantName {
			t.Errorf("Detect(%q, \"\").Name() = %q, want %q", tc.command, p.Name(), tc.wantName)
		}
	}
}

func TestDetect_OverrideWins(t *testing.T) {
	// Even if the binary is "claude", override forces gemini.
	p := Detect("claude", "gemini")
	if p.Name() != "gemini" {
		t.Errorf("override ignored: got %q, want gemini", p.Name())
	}
}

func TestDetect_OverrideCaseInsensitive(t *testing.T) {
	p := Detect("anything", "GEMINI")
	if p.Name() != "gemini" {
		t.Errorf("override case-sensitivity: got %q, want gemini", p.Name())
	}
}

func TestDetect_UnknownDefaultsClaude(t *testing.T) {
	p := Detect("some-unknown-tool", "")
	if p.Name() != "claude-code" {
		t.Errorf("unknown binary should default to claude-code, got %q", p.Name())
	}
}

func TestDetect_UnknownOverrideDefaultsClaude(t *testing.T) {
	p := Detect("claude", "totally-unknown-override")
	// unknown override falls through to binary detection
	if p.Name() != "claude-code" {
		t.Errorf("unknown override should fall back to binary detection, got %q", p.Name())
	}
}

func TestDetect_CommandWithArguments(t *testing.T) {
	// "claude --dangerously-skip-permissions" → binary is "claude"
	p := Detect("claude --dangerously-skip-permissions", "")
	if p.Name() != "claude-code" {
		t.Errorf("got %q, want claude-code", p.Name())
	}
}

func TestProvider_ClaudeCode_Basics(t *testing.T) {
	p := &ClaudeCode{}
	if p.Name() != "claude-code" {
		t.Errorf("Name() = %q", p.Name())
	}
	if !p.UsesHooks() {
		t.Error("ClaudeCode should use hooks")
	}
	// stdin-based: empty prompt passes via stdin
	stdin := p.Stdin("hello")
	if stdin == "" {
		t.Error("ClaudeCode.Stdin should return non-empty (stdin-based provider)")
	}
}

func TestProvider_ClaudeCode_SetupIsNoop(t *testing.T) {
	// Setup must not write into the shared, workDir-scoped settings file
	// anymore — that's what let an unrelated `claude` process in the same
	// directory inherit and fire another task's hooks.
	tmpDir := t.TempDir()
	p := &ClaudeCode{}
	if err := p.Setup(tmpDir, 7374, "agent-123", "task-456"); err != nil {
		t.Fatalf("Setup failed: %v", err)
	}
	if _, err := os.Stat(tmpDir + "/.claude/settings.json"); !os.IsNotExist(err) {
		t.Fatalf("Setup should not write %s/.claude/settings.json, got err=%v", tmpDir, err)
	}
}

func TestProvider_ClaudeCode_SetupArgsScopesHooksToInvocation(t *testing.T) {
	p := &ClaudeCode{}
	args := p.SetupArgs(7374, "agent-123", "task-456")
	if len(args) != 2 || args[0] != "--settings" {
		t.Fatalf("SetupArgs() = %v, want [--settings <path>]", args)
	}
	settingsPath := args[1]
	defer os.Remove(settingsPath)

	data, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("Failed to read %s: %v", settingsPath, err)
	}
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("Failed to parse %s: %v", settingsPath, err)
	}
	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		t.Fatal("settings missing 'hooks' key")
	}
	if _, ok := hooks["Stop"]; !ok {
		t.Error("settings missing 'Stop' hook")
	}
	if _, ok := hooks["StopFailure"]; !ok {
		t.Error("settings missing 'StopFailure' hook")
	}
	if !strings.Contains(string(data), "agent=agent-123") || !strings.Contains(string(data), "task_id=task-456") {
		t.Errorf("settings hooks missing expected agent/task_id query params: %s", data)
	}
	if _, ok := hooks["PreToolUse"]; !ok {
		t.Error("settings missing 'PreToolUse' hook")
	}
	if _, ok := hooks["PostToolUse"]; !ok {
		t.Error("settings missing 'PostToolUse' hook")
	}
}

func TestProvider_ClaudeCode_SetupArgsPreToolUseMatchesAskUserQuestion(t *testing.T) {
	p := &ClaudeCode{}
	args := p.SetupArgs(7374, "agent-123", "task-456")
	settingsPath := args[1]
	defer os.Remove(settingsPath)

	data, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("Failed to read %s: %v", settingsPath, err)
	}
	var settings struct {
		Hooks struct {
			PreToolUse []struct {
				Matcher string `json:"matcher"`
				Hooks   []struct {
					URL string `json:"url"`
				} `json:"hooks"`
			} `json:"PreToolUse"`
			PostToolUse []struct {
				Matcher string `json:"matcher"`
				Hooks   []struct {
					URL string `json:"url"`
				} `json:"hooks"`
			} `json:"PostToolUse"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("Failed to parse %s: %v", settingsPath, err)
	}

	if len(settings.Hooks.PreToolUse) != 1 || settings.Hooks.PreToolUse[0].Matcher != "AskUserQuestion" {
		t.Fatalf("PreToolUse = %+v, want one entry matching AskUserQuestion", settings.Hooks.PreToolUse)
	}
	if !strings.Contains(settings.Hooks.PreToolUse[0].Hooks[0].URL, "/hooks/tui-blocked") ||
		!strings.Contains(settings.Hooks.PreToolUse[0].Hooks[0].URL, "state=on") {
		t.Errorf("PreToolUse URL = %q, want /hooks/tui-blocked?...state=on", settings.Hooks.PreToolUse[0].Hooks[0].URL)
	}

	if len(settings.Hooks.PostToolUse) != 1 || settings.Hooks.PostToolUse[0].Matcher != "AskUserQuestion" {
		t.Fatalf("PostToolUse = %+v, want one entry matching AskUserQuestion", settings.Hooks.PostToolUse)
	}
	if !strings.Contains(settings.Hooks.PostToolUse[0].Hooks[0].URL, "/hooks/tui-blocked") ||
		!strings.Contains(settings.Hooks.PostToolUse[0].Hooks[0].URL, "state=off") {
		t.Errorf("PostToolUse URL = %q, want /hooks/tui-blocked?...state=off", settings.Hooks.PostToolUse[0].Hooks[0].URL)
	}
}

func TestProvider_Gemini_Basics(t *testing.T) {
	p := &Gemini{}
	if p.Name() != "gemini" {
		t.Errorf("Name() = %q", p.Name())
	}
	if !p.UsesHooks() {
		t.Error("Gemini should use hooks")
	}
}

func TestProvider_Gemini_SetsUpAfterAgentHook(t *testing.T) {
	// Create a temp directory for the test
	tmpDir := t.TempDir()

	p := &Gemini{}
	err := p.Setup(tmpDir, 7374, "agent-123", "task-456")
	if err != nil {
		t.Fatalf("Setup failed: %v", err)
	}

	// Read the generated settings.json
	settingsPath := tmpDir + "/.gemini/settings.json"
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("Failed to read settings.json: %v", err)
	}

	// Parse and verify the hooks
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("Failed to parse settings.json: %v", err)
	}

	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		t.Fatal("settings.json missing 'hooks' key")
	}

	// Should only have AfterAgent hook (no SessionEnd, no Notification)
	if _, hasSessionEnd := hooks["SessionEnd"]; hasSessionEnd {
		t.Error("不应该有 SessionEnd hook")
	}
	if _, hasNotif := hooks["Notification"]; hasNotif {
		t.Error("不应该有 Notification hook")
	}

	afterAgent, ok := hooks["AfterAgent"].([]any)
	if !ok || len(afterAgent) == 0 {
		t.Fatal("缺少 AfterAgent hook")
	}

	// Verify the hook calls /hooks/stop
	hookConfig, ok := afterAgent[0].(map[string]any)
	if !ok {
		t.Fatal("AfterAgent hook config 格式错误")
	}
	hooksList, ok := hookConfig["hooks"].([]any)
	if len(hooksList) == 0 {
		t.Fatal("AfterAgent hooks list 为空")
	}
	cmdHook, ok := hooksList[0].(map[string]any)
	if !ok {
		t.Fatal("AfterAgent hook 格式错误")
	}

	cmd, ok := cmdHook["command"].(string)
	if !ok {
		t.Fatal("缺少 command 字段")
	}
	// Verify it points to /hooks/stop, not /hooks/after_agent
	if !strings.Contains(cmd, "/hooks/stop") {
		t.Errorf("hook command 应该包含 /hooks/stop，实际: %s", cmd)
	}
	if strings.Contains(cmd, "/hooks/after_agent") {
		t.Error("hook command 不应该包含 /hooks/after_agent")
	}
}

func TestProvider_Codex_Basics(t *testing.T) {
	p := &Codex{}
	if p.Name() != "codex" {
		t.Errorf("Name() = %q", p.Name())
	}
	if !p.UsesHooks() {
		t.Error("Codex should use hooks")
	}
	// Codex uses -p flag (not stdin)
	if p.Stdin("prompt") != "" {
		t.Error("Codex should use -p flag, not stdin")
	}
}

func TestProvider_Stdout_Basics(t *testing.T) {
	p := &Stdout{}
	if p.Name() != "stdout" {
		t.Errorf("Name() = %q", p.Name())
	}
	if p.UsesHooks() {
		t.Error("Stdout should not use hooks")
	}
}

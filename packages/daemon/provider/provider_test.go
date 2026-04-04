package provider

import "testing"

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

func TestProvider_Gemini_Basics(t *testing.T) {
	p := &Gemini{}
	if p.Name() != "gemini" {
		t.Errorf("Name() = %q", p.Name())
	}
	if !p.UsesHooks() {
		t.Error("Gemini should use hooks")
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

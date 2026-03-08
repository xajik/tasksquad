package provider

import (
	"path/filepath"
	"strings"
)

// Provider describes how the daemon integrates with a specific CLI tool.
//
// Each provider knows how to:
//   - Write hook config files into the work directory before spawning (Setup)
//   - Inject extra environment variables into the spawned process (Env)
//   - Report whether it signals completion via HTTP hooks (UsesHooks)
//   - Supply a stdin payload instead of a -p flag (Stdin)
//
// If UsesHooks returns false the daemon falls back to process-exit detection only.
// If Stdin returns a non-empty string the daemon pipes that string to the process
// stdin and omits the -p flag; this is required for account-login Claude Code users
// who cannot use -p (API credit mode).
type Provider interface {
	Name() string
	Setup(workDir string, hooksPort int, agentName string) error
	Env(hooksPort int) []string
	UsesHooks() bool
	// Stdin returns the content to pipe to the process stdin, or "" to use -p flag.
	Stdin(prompt string) string
	// ExtraArgs returns additional CLI arguments to prepend (e.g. --dangerously-skip-permissions).
	ExtraArgs() []string
}

// Detect returns the provider for the given command.
// override (from agents[].provider in config) takes precedence over auto-detection.
func Detect(command, override string) Provider {
	if override != "" {
		switch strings.ToLower(override) {
		case "claude-code", "claude":
			return &ClaudeCode{}
		case "gemini":
			return &Gemini{}
		case "opencode":
			return &OpenCode{}
		case "codex":
			return &Codex{}
		case "stdout":
			return &Stdout{}
		}
	}

	// Auto-detect from the command content.
	// If it contains "gemini", use Gemini provider.
	// Otherwise check binary name, defaulting to Claude.
	cmdLower := strings.ToLower(command)
	if strings.Contains(cmdLower, "gemini") {
		return &Gemini{}
	}

	bin := command
	if fields := strings.Fields(command); len(fields) > 0 {
		bin = filepath.Base(fields[0])
	}
	switch strings.ToLower(bin) {
	case "claude":
		return &ClaudeCode{}
	case "opencode":
		return &OpenCode{}
	case "codex":
		return &Codex{}
	default:
		// Default to Claude as requested.
		return &ClaudeCode{}
	}
}

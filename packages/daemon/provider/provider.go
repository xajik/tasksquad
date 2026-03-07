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
//
// If UsesHooks returns false the daemon falls back to process-exit detection only.
type Provider interface {
	Name() string
	Setup(workDir string, hooksPort int) error
	Env(hooksPort int) []string
	UsesHooks() bool
}

// Detect returns the provider for the given command.
// override (from agents[].provider in config) takes precedence over auto-detection.
func Detect(command, override string) Provider {
	if override != "" {
		switch strings.ToLower(override) {
		case "claude-code", "claude":
			return &ClaudeCode{}
		case "opencode":
			return &OpenCode{}
		case "codex":
			return &Codex{}
		case "stdout":
			return &Stdout{}
		}
	}

	// Auto-detect from the binary name of the command.
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
		return &Stdout{}
	}
}

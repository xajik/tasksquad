package provider

import (
	"errors"
	"path/filepath"
	"strings"
)

// ErrNotSupported is returned when a provider doesn't support a given feature.
var ErrNotSupported = errors.New("provider does not support this feature")

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
	// CLIName returns the binary name used by this provider's CLI tool (e.g. "claude",
	// "agent"). Used by Detect() to auto-identify a provider from the command field in
	// config without requiring an explicit provider override.
	CLIName() string
	// Setup writes per-task hook configuration into workDir.
	// agentID (server-assigned UUID) and taskID are embedded in hook URLs so the
	// hook server can route to the correct agent and reject stale events.
	Setup(workDir string, hooksPort int, agentID string, taskID string) error
	// SetupVoice writes hook config for speech-to-md notification.
	// Returns ErrNotSupported if the provider doesn't support speech hooks.
	SetupVoice(workDir string, hooksPort int) error
	Env(hooksPort int) []string
	UsesHooks() bool
	// Stdin returns the content to pipe to the process stdin, or "" to use -p flag.
	Stdin(prompt string) string
	// ExtraArgs returns additional CLI arguments to prepend (e.g. --dangerously-skip-permissions).
	ExtraArgs() []string

	// VoiceCLIArg returns an extra argument string to append to the CLI command
	// when starting a speech-to-md session (e.g. "--agent tsq-speech-to-md"), or "".
	VoiceCLIArg() string
	// VoiceInitCommand returns the command to send via tmux.SendKeys after the
	// session starts, to invoke the speech-to-md skill. Can be overridden by
	// the user's promptOverride. For Claude-style: "/tsq-speech-to-md". For Gemini: "@tsq-speech-to-md".
	VoiceInitCommand() string
}

// registry maps canonical provider name strings to factory functions.
// Used for explicit override lookups (agents[].provider in config).
var registry = map[string]func() Provider{
	"claude-code": func() Provider { return &ClaudeCode{} },
	"claude":      func() Provider { return &ClaudeCode{} },
	"gemini":      func() Provider { return &Gemini{} },
	"opencode":    func() Provider { return &OpenCode{} },
	"codex":       func() Provider { return &Codex{} },
	"stdout":      func() Provider { return &Stdout{} },
	"claw":        func() Provider { return &Claw{} },
}

// cliRegistry maps CLI binary names (from CLIName()) to factory functions.
// Built at init so Detect() can identify providers by their binary without
// hardcoded special cases.
var cliRegistry map[string]func() Provider

func init() {
	cliRegistry = make(map[string]func() Provider, len(registry))
	for _, factory := range registry {
		p := factory()
		if name := p.CLIName(); name != "" {
			cliRegistry[name] = factory
		}
	}
}

// Detect returns the provider for the given command.
// override (from agents[].provider in config) takes precedence over auto-detection.
func Detect(command, override string) Provider {
	if override != "" {
		if factory, ok := registry[strings.ToLower(override)]; ok {
			return factory()
		}
	}

	bin := command
	if fields := strings.Fields(command); len(fields) > 0 {
		bin = filepath.Base(fields[0])
	}
	bin = strings.ToLower(bin)
	if factory, ok := registry[bin]; ok {
		return factory()
	}
	if factory, ok := cliRegistry[bin]; ok {
		return factory()
	}
	// Default to Claude as requested.
	return &ClaudeCode{}
}

package provider

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/tasksquad/daemon/logger"
)

// ClaudeCode is the provider for Anthropic's Claude Code CLI.
//
// Completion is signalled via a Stop hook → POST /hooks/stop (task finished).
// The hook config is passed per-invocation via SetupArgs' --settings flag
// (not written to <workDir>/.claude/settings.json — see Setup below).
//
// The daemon hook server (hooks/server.go) receives these and calls
// agent.Complete() accordingly.
type ClaudeCode struct{}

func (p *ClaudeCode) Name() string       { return "claude-code" }
func (p *ClaudeCode) CLIName() string    { return "claude" }
func (p *ClaudeCode) UsesHooks() bool    { return true }
func (p *ClaudeCode) Env(_ int) []string { return nil }

// Stdin pipes the prompt via stdin so account-login users (no API credits)
// can run non-interactively without the -p flag.
func (p *ClaudeCode) Stdin(prompt string) string { return prompt }

func (p *ClaudeCode) ExtraArgs() []string      { return nil }
func (p *ClaudeCode) VoiceCLIArg() string       { return "--agent tsq-speech-to-md" }
func (p *ClaudeCode) VoiceInitCommand() string  { return "/tsq-speech-to-md" }

// Setup is a no-op for ClaudeCode: hook config is delivered per-invocation
// via SetupArgs instead of being written here. Writing hooks into
// <workDir>/.claude/settings.json used to mean ANY `claude` process launched
// in workDir — including one a user starts manually in a terminal — would
// inherit and fire this task's Stop hook, letting an unrelated session's
// transcript get misattributed to this task. See SetupArgs.
func (p *ClaudeCode) Setup(_ string, _ int, _ string, _ string) error {
	return nil
}

// tuiBlockMatchers lists the built-in tools that present a blocking,
// interactive TUI menu in the raw terminal (arrow-key navigation, no chat
// message involved) — confirmed via direct observation that no other hook
// fires while one of these is on screen. Extend this list if another such
// tool is confirmed (e.g. ExitPlanMode's approve/reject prompt looks like a
// similar case, but isn't confirmed yet).
var tuiBlockMatchers = []string{"AskUserQuestion"}

// hooksJSON builds the Stop/StopFailure/PreToolUse/PostToolUse hook config
// pointing at the daemon's local hook server, with agentID/taskID embedded
// as query params so the hook server can route to the correct agent and
// reject stale events. PreToolUse/PostToolUse are scoped to
// tuiBlockMatchers and flip the "blocked on an interactive TUI prompt" flag
// that gates the live terminal's raw keystroke forwarding (see
// hooks/handlers.go handleTUIBlocked) — distinct from Stop/StopFailure,
// which report task completion.
func hooksJSON(hooksPort int, agentID, taskID string) ([]byte, error) {
	var preToolUse, postToolUse []any
	for _, matcher := range tuiBlockMatchers {
		preToolUse = append(preToolUse, map[string]any{
			"matcher": matcher,
			"hooks": []any{
				map[string]any{
					"type": "http",
					"url":  fmt.Sprintf("http://localhost:%d/hooks/tui-blocked?agent=%s&task_id=%s&state=on", hooksPort, agentID, taskID),
				},
			},
		})
		postToolUse = append(postToolUse, map[string]any{
			"matcher": matcher,
			"hooks": []any{
				map[string]any{
					"type": "http",
					"url":  fmt.Sprintf("http://localhost:%d/hooks/tui-blocked?agent=%s&task_id=%s&state=off", hooksPort, agentID, taskID),
				},
			},
		})
	}
	return json.Marshal(map[string]any{
		"hooks": map[string]any{
			"Stop": []any{
				map[string]any{
					"matcher": "*",
					"hooks": []any{
						map[string]any{
							"type": "http",
							"url":  fmt.Sprintf("http://localhost:%d/hooks/stop?agent=%s&task_id=%s", hooksPort, agentID, taskID),
						},
					},
				},
			},
			"StopFailure": []any{
				map[string]any{
					"matcher": "*",
					"hooks": []any{
						map[string]any{
							"type": "http",
							"url":  fmt.Sprintf("http://localhost:%d/hooks/stop?agent=%s&task_id=%s&failure=true", hooksPort, agentID, taskID),
						},
					},
				},
			},
			"PreToolUse":  preToolUse,
			"PostToolUse": postToolUse,
		},
	})
}

// SetupArgs writes this task's Stop/StopFailure/PreToolUse/PostToolUse hook
// config to a temp file scoped to this exact invocation (named after
// agentID+taskID, outside workDir) and returns the --settings flag pointing
// at it. Claude Code loads --settings in addition to any project/user
// settings, so this task's hooks never touch the shared
// <workDir>/.claude/settings.json a manually-run `claude` process in the
// same directory would also read.
func (p *ClaudeCode) SetupArgs(hooksPort int, agentID string, taskID string) []string {
	data, err := hooksJSON(hooksPort, agentID, taskID)
	if err != nil {
		logger.Error(fmt.Sprintf("[provider/claude-code] marshal hooks: %v", err))
		return nil
	}
	settingsPath := filepath.Join(os.TempDir(), fmt.Sprintf("tsq-settings-%s-%s.json", agentID, taskID))
	if err := os.WriteFile(settingsPath, data, 0644); err != nil {
		logger.Error(fmt.Sprintf("[provider/claude-code] write settings temp file: %v", err))
		return nil
	}
	logger.Debug(fmt.Sprintf("[provider/claude-code] Wrote per-task hooks to %s (port %d)", settingsPath, hooksPort))
	return []string{"--settings", settingsPath}
}

// SetupVoice is a no-op for ClaudeCode: hook config is delivered via
// VoiceSetupArgs instead, for the same reason Setup() is a no-op above —
// writing into <workDir>/.claude/settings.json is visible to any `claude`
// process launched in that directory, not just the speech-to-md session.
func (p *ClaudeCode) SetupVoice(_ string, _ int) error {
	return nil
}

// VoiceSetupArgs writes the speech-to-md Stop hook config to a temp file
// scoped to this invocation and returns the --settings flag pointing at it,
// mirroring SetupArgs for the voice flow. Not part of the Provider interface
// (voice is opt-in per provider); callers should type-assert for it.
func (p *ClaudeCode) VoiceSetupArgs(hooksPort int) []string {
	url := fmt.Sprintf("http://localhost:%d/hooks/stop?speech=true&provider=claude-code", hooksPort)
	stopHook := []any{
		map[string]any{
			"matcher": "*",
			"hooks":   []any{map[string]any{"type": "http", "url": url}},
		},
	}
	data, err := json.Marshal(map[string]any{
		"hooks": map[string]any{"Stop": stopHook, "StopFailure": stopHook},
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[provider/claude-code] marshal voice hooks: %v", err))
		return nil
	}
	settingsPath := filepath.Join(os.TempDir(), fmt.Sprintf("tsq-voice-settings-%d.json", hooksPort))
	if err := os.WriteFile(settingsPath, data, 0644); err != nil {
		logger.Error(fmt.Sprintf("[provider/claude-code] write voice settings temp file: %v", err))
		return nil
	}
	logger.Debug(fmt.Sprintf("[provider/claude-code] Wrote per-invocation voice hooks to %s (port %d)", settingsPath, hooksPort))
	return []string{"--settings", settingsPath}
}

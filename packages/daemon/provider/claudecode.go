package provider

import (
	"fmt"
	"path/filepath"

	"github.com/tasksquad/daemon/logger"
)

// ClaudeCode is the provider for Anthropic's Claude Code CLI.
//
// Completion is signalled via hooks written to <workDir>/.claude/settings.json:
//   - Stop hook → POST /hooks/stop (task finished)
//
// The daemon hook server (hooks/server.go) receives these and calls
// agent.Complete() accordingly.
type ClaudeCode struct{}

func (p *ClaudeCode) Name() string       { return "claude-code" }
func (p *ClaudeCode) UsesHooks() bool    { return true }
func (p *ClaudeCode) Env(_ int) []string { return nil }

// Stdin pipes the prompt via stdin so account-login users (no API credits)
// can run non-interactively without the -p flag.
func (p *ClaudeCode) Stdin(prompt string) string { return prompt }

func (p *ClaudeCode) ExtraArgs() []string { return nil }

// Setup writes .claude/settings.json into workDir with Stop hooks
// pointing to the daemon's local hook server on hooksPort.
func (p *ClaudeCode) Setup(workDir string, hooksPort int, agentID string, taskID string) error {
	settingsPath := filepath.Join(workDir, ".claude", "settings.json")
	err := writeHooks(settingsPath, map[string]any{
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
				"hooks": []any{
					map[string]any{
						"type": "http",
						"url":  fmt.Sprintf("http://localhost:%d/hooks/stop?agent=%s&task_id=%s&failure=true", hooksPort, agentID, taskID),
					},
				},
			},
		},
	})
	if err != nil {
		return err
	}
	logger.Debug(fmt.Sprintf("[provider/claude-code] Wrote hooks to %s (port %d)", settingsPath, hooksPort))
	return nil
}

// SetupVoice writes .claude/settings.json with a Notification hook pointing at
// the speech-to-md notification endpoint. Called by speechtomd.AgentSession.Start().
func (p *ClaudeCode) SetupVoice(workDir string, hooksPort int) error {
	settingsPath := filepath.Join(workDir, ".claude", "settings.json")
	err := writeHooks(settingsPath, map[string]any{
		"Notification": []any{
			map[string]any{
				"matcher": "*",
				"hooks": []any{
					map[string]any{
						"type": "http",
						"url":  fmt.Sprintf("http://localhost:%d/hooks/speech-to-md/notification?provider=claude-code", hooksPort),
					},
				},
			},
		},
	})
	if err != nil {
		return err
	}
	logger.Debug(fmt.Sprintf("[provider/claude-code] Wrote voice hooks to %s (port %d)", settingsPath, hooksPort))
	return nil
}

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
// Completion is signalled via hooks written to <workDir>/.claude/settings.json:
//   - Stop hook       → POST /hooks/stop        (task finished)
//   - Notification hook → POST /hooks/notification (waiting for input)
//
// The daemon hook server (hooks/server.go) receives these and calls
// agent.Complete() / agent.SetWaitingInput() accordingly.
type ClaudeCode struct{}

func (p *ClaudeCode) Name() string       { return "claude-code" }
func (p *ClaudeCode) UsesHooks() bool    { return true }
func (p *ClaudeCode) Env(_ int) []string { return nil }

// Stdin pipes the prompt via stdin so account-login users (no API credits)
// can run non-interactively without the -p flag.
func (p *ClaudeCode) Stdin(prompt string) string { return prompt }

func (p *ClaudeCode) ExtraArgs() []string { return nil }

// Setup writes .claude/settings.json into workDir with Stop and Notification hooks
// pointing to the daemon's local hook server on hooksPort.
func (p *ClaudeCode) Setup(workDir string, hooksPort int, agentID string, taskID string) error {
	claudeDir := filepath.Join(workDir, ".claude")
	settingsPath := filepath.Join(claudeDir, "settings.json")

	if err := os.MkdirAll(claudeDir, 0755); err != nil {
		return fmt.Errorf("create .claude dir: %w", err)
	}

	// Preserve existing settings; only overwrite the hooks key.
	existing := make(map[string]any)
	if data, err := os.ReadFile(settingsPath); err == nil {
		_ = json.Unmarshal(data, &existing)
	}

	existing["hooks"] = map[string]any{
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
		"Notification": []any{
			map[string]any{
				"matcher": "*",
				"hooks": []any{
					map[string]any{
						"type": "http",
						"url":  fmt.Sprintf("http://localhost:%d/hooks/notification?agent=%s&task_id=%s", hooksPort, agentID, taskID),
					},
				},
			},
		},
	}

	data, err := json.MarshalIndent(existing, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal settings: %w", err)
	}
	if err := os.WriteFile(settingsPath, data, 0644); err != nil {
		return fmt.Errorf("write settings: %w", err)
	}

	logger.Debug(fmt.Sprintf("[provider/claude-code] Wrote hooks to %s (port %d)", settingsPath, hooksPort))
	return nil
}

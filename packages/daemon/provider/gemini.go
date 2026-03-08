package provider

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/tasksquad/daemon/logger"
)

// Gemini is the provider for Google's Gemini CLI.
//
// Completion is signalled via hooks written to <workDir>/.gemini/settings.json:
//   - SessionEnd hook   → POST /hooks/stop        (task finished)
//   - Notification hook → POST /hooks/notification (waiting for input)
//
// The daemon hook server (hooks/server.go) receives these and calls
// agent.Complete() / agent.SetWaitingInput() accordingly.
type Gemini struct{}

func (p *Gemini) Name() string       { return "gemini" }
func (p *Gemini) UsesHooks() bool    { return true }
func (p *Gemini) Env(_ int) []string { return nil }

// Stdin pipes the prompt via stdin so account-login users (no API credits)
// can run non-interactively without the -p flag.
func (p *Gemini) Stdin(prompt string) string { return prompt }

func (p *Gemini) ExtraArgs() []string { return nil }

// Setup writes .gemini/settings.json into workDir with SessionEnd and Notification hooks
// pointing to the daemon's local hook server on hooksPort.
func (p *Gemini) Setup(workDir string, hooksPort int, agentName string) error {
	geminiDir := filepath.Join(workDir, ".gemini")
	settingsPath := filepath.Join(geminiDir, "settings.json")

	if err := os.MkdirAll(geminiDir, 0755); err != nil {
		return fmt.Errorf("create .gemini dir: %w", err)
	}

	// Preserve existing settings; only overwrite the hooks key.
	existing := make(map[string]any)
	if data, err := os.ReadFile(settingsPath); err == nil {
		_ = json.Unmarshal(data, &existing)
	}

	// Gemini CLI hooks structure: {"hooks": {"EventName": [{"matcher": "*", "hooks": [...]}]}}
	existing["hooks"] = map[string]any{
		"SessionEnd": []any{
			map[string]any{
				"matcher": "*",
				"hooks": []any{
					map[string]any{
						"type": "http",
						"url":  fmt.Sprintf("http://127.0.0.1:%d/hooks/stop?agent=%s&provider=gemini", hooksPort, agentName),
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
						"url":  fmt.Sprintf("http://127.0.0.1:%d/hooks/notification?agent=%s&provider=gemini", hooksPort, agentName),
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

	logger.Debug(fmt.Sprintf("[provider/gemini] Wrote hooks to %s (port %d)", settingsPath, hooksPort))
	return nil
}

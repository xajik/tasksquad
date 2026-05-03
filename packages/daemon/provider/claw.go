package provider

import (
	"fmt"
	"path/filepath"

	"github.com/tasksquad/daemon/logger"
)

// Claw is the provider for the Claw Code CLI (command: agent).
//
// Completion is signalled via hooks written to <workDir>/.agent/settings.json:
//   - Stop hook → POST /hooks/stop (task finished)
//
// Skills, sub-agents, and commands are loaded from <workDir>/.agent/ by the CLI.
type Claw struct{}

func (p *Claw) Name() string       { return "claw" }
func (p *Claw) CLIName() string    { return "agent" }
func (p *Claw) UsesHooks() bool    { return true }
func (p *Claw) Env(_ int) []string { return nil }

// Stdin pipes the prompt via stdin so account-login users (no API credits)
// can run non-interactively without the -p flag.
func (p *Claw) Stdin(prompt string) string { return prompt }

func (p *Claw) ExtraArgs() []string       { return nil }
func (p *Claw) VoiceCLIArg() string      { return "--agent tsq-speech-to-md" }
func (p *Claw) VoiceInitCommand() string { return "/tsq-speech-to-md" }

// Setup writes .agent/settings.json into workDir with Stop hooks
// pointing to the daemon's local hook server on hooksPort.
func (p *Claw) Setup(workDir string, hooksPort int, agentID string, taskID string) error {
	settingsPath := filepath.Join(workDir, ".agent", "settings.json")
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
	logger.Debug(fmt.Sprintf("[provider/claw] Wrote hooks to %s (port %d)", settingsPath, hooksPort))
	return nil
}

// SetupVoice writes .agent/settings.json with Stop hooks pointing at the
// daemon's /hooks/stop endpoint with speech=true, mirroring the inbox setup.
func (p *Claw) SetupVoice(workDir string, hooksPort int) error {
	settingsPath := filepath.Join(workDir, ".agent", "settings.json")
	url := fmt.Sprintf("http://localhost:%d/hooks/stop?speech=true&provider=claw", hooksPort)
	stopHook := []any{
		map[string]any{
			"matcher": "*",
			"hooks":   []any{map[string]any{"type": "http", "url": url}},
		},
	}
	err := writeHooks(settingsPath, map[string]any{
		"Stop":        stopHook,
		"StopFailure": stopHook,
	})
	if err != nil {
		return err
	}
	logger.Debug(fmt.Sprintf("[provider/claw] Wrote voice hooks to %s (port %d)", settingsPath, hooksPort))
	return nil
}

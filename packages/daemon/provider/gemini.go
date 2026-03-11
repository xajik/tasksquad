package provider

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

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

func (p *Gemini) Name() string    { return "gemini" }
func (p *Gemini) UsesHooks() bool { return true }
func (p *Gemini) Env(_ int) []string {
	return []string{"GEMINI_TRUST_WORKSPACE=1"}
}

// Stdin pipes the prompt via stdin so account-login users (no API credits)
// can run non-interactively without the -p flag.
func (p *Gemini) Stdin(prompt string) string { return prompt }

func (p *Gemini) ExtraArgs() []string        { return nil }
func (p *Gemini) TmuxReadyIndicator() string { return "Ready" }

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

	stopURL := fmt.Sprintf("http://127.0.0.1:%d/hooks/stop?agent=%s&provider=gemini", hooksPort, agentName)
	notifURL := fmt.Sprintf("http://127.0.0.1:%d/hooks/notification?agent=%s&provider=gemini", hooksPort, agentName)
	afterAgentURL := fmt.Sprintf("http://127.0.0.1:%d/hooks/after_agent?agent=%s&provider=gemini", hooksPort, agentName)

	// Gemini CLI hooks structure: {"hooks": {"EventName": [{"matcher": "*", "hooks": [...]}]}}
	existing["hooks"] = map[string]any{
		"SessionEnd": []any{
			map[string]any{
				"matcher": "*",
				"hooks": []any{
					map[string]any{
						"name":    "tasksquad-stop",
						"type":    "command",
						"command": geminiHookCmd(stopURL),
						"timeout": 5000,
					},
				},
			},
		},
		"Notification": []any{
			map[string]any{
				"matcher": "*",
				"hooks": []any{
					map[string]any{
						"name":    "tasksquad-notif",
						"type":    "command",
						"command": geminiHookCmd(notifURL),
						"timeout": 5000,
					},
				},
			},
		},
		"AfterAgent": []any{
			map[string]any{
				"matcher": "*",
				"hooks": []any{
					map[string]any{
						"name":    "tasksquad-after-agent",
						"type":    "command",
						"command": geminiHookCmd(afterAgentURL),
						"timeout": 5000,
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

// geminiHookCmd returns a shell command that POSTs stdin to url and outputs {}
// so Gemini CLI receives valid JSON back (required by the command hook contract).
// The command is tailored to the OS shell Gemini uses to execute hooks:
//   - Unix (macOS/Linux): /bin/sh — curl + printf
//   - Windows: cmd.exe — curl + echo
func geminiHookCmd(url string) string {
	if runtime.GOOS == "windows" {
		// cmd.exe syntax: NUL instead of /dev/null, & to chain, echo for JSON output.
		// We use -sS to keep curl quiet but still show errors in stderr if they occur.
		return fmt.Sprintf(`curl -sS -X POST "%s" -H "Content-Type: application/json" -d @- > NUL 2>&1 & echo {}`, url)
	}
	return fmt.Sprintf(`curl -sS -X POST "%s" -H "Content-Type: application/json" -d @- > /dev/null 2>&1; printf '{}'`, url)
}

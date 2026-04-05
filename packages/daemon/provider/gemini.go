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
// Completion is signalled via AfterAgent hook written to <workDir>/.gemini/settings.json:
//   - AfterAgent hook → POST /hooks/stop (task finished)
//
// The daemon hook server (hooks/server.go) receives this and calls
// agent.StopAndPause() which posts the final message and moves to waiting_input.
// With auto_close enabled, the worker converts waiting_input to closed (done).
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

// Setup writes .gemini/settings.json into workDir with AfterAgent hook
// pointing to the daemon's local hook server on hooksPort.
func (p *Gemini) Setup(workDir string, hooksPort int, agentID string, taskID string) error {
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

	// AfterAgent triggers on every model turn. We use it as the completion signal
	// to align with Claude Code's Stop hook behavior.
	stopURL := fmt.Sprintf("http://localhost:%d/hooks/stop?agent=%s&task_id=%s&provider=gemini", hooksPort, agentID, taskID)

	// Gemini CLI hooks structure: {"hooks": {"EventName": [{"matcher": "*", "hooks": [...]}]}}
	existing["hooks"] = map[string]any{
		"AfterAgent": []any{
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

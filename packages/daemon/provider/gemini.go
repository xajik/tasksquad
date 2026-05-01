package provider

import (
	"fmt"
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

// SetupVoice writes .gemini/settings.json with an AfterAgent hook pointing at
// the speech-to-md notification endpoint.
func (p *Gemini) SetupVoice(workDir string, hooksPort int) error {
	settingsPath := filepath.Join(workDir, ".gemini", "settings.json")
	err := writeHooks(settingsPath, map[string]any{
		"AfterAgent": []any{
			map[string]any{
				"matcher": "*",
				"hooks": []any{
					map[string]any{
						"name":    "tasksquad-speech",
						"type":    "command",
						"command": geminiHookCmd(fmt.Sprintf("http://localhost:%d/hooks/speech-to-md/notification?provider=gemini", hooksPort)),
						"timeout": 5000,
					},
				},
			},
		},
	})
	if err != nil {
		return err
	}
	logger.Debug(fmt.Sprintf("[provider/gemini] Wrote voice hooks to %s (port %d)", settingsPath, hooksPort))
	return nil
}

// Setup writes .gemini/settings.json into workDir with AfterAgent hook
// pointing to the daemon's local hook server on hooksPort.
func (p *Gemini) Setup(workDir string, hooksPort int, agentID string, taskID string) error {
	settingsPath := filepath.Join(workDir, ".gemini", "settings.json")
	stopURL := fmt.Sprintf("http://localhost:%d/hooks/stop?agent=%s&task_id=%s&provider=gemini", hooksPort, agentID, taskID)
	// AfterAgent triggers on every model turn. We use it as the completion signal
	// to align with Claude Code's Stop hook behavior.
	err := writeHooks(settingsPath, map[string]any{
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
	})
	if err != nil {
		return err
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

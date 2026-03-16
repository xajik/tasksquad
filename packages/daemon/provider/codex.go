package provider

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/tasksquad/daemon/logger"
)

// Codex is the provider for OpenAI's codex CLI.
//
// Completion is signalled via the `notify` field in ~/.codex/config.toml.
// When set, codex runs that shell command after each agent turn, piping a JSON
// payload to stdin:
//
//	{"type":"agent-turn-complete","turn-id":"...","last-assistant-message":"..."}
//
// Setup() writes the notify command pointing to the daemon's hook server so
// hooks/server.go can call agent.StopAndPause() on completion.
//
// Note: ~/.codex/config.toml is a global file; the agent name is embedded in
// the URL so the hook server can route correctly even if multiple Codex agents
// are configured on the same machine (sequential execution only — concurrent
// Codex agents sharing the same hook server are not supported).
//
// Codex has no notification/waiting-for-input hook, so SetWaitingInput is
// never triggered from hooks; the daemon relies on process-exit detection for
// that case.
type Codex struct{}

func (p *Codex) Name() string            { return "codex" }
func (p *Codex) UsesHooks() bool         { return true }
func (p *Codex) Env(_ int) []string      { return nil }
func (p *Codex) Stdin(_ string) string   { return "" }
func (p *Codex) ExtraArgs() []string     { return nil }

// Setup updates ~/.codex/config.toml with a notify command that POSTs the
// codex turn-complete payload to the daemon's local hook server.
func (p *Codex) Setup(_ string, hooksPort int, agentID string, taskID string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("get home dir: %w", err)
	}

	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0755); err != nil {
		return fmt.Errorf("create .codex dir: %w", err)
	}

	configPath := filepath.Join(codexDir, "config.toml")
	stopURL := fmt.Sprintf("http://localhost:%d/hooks/codex?agent=%s&task_id=%s", hooksPort, agentID, taskID)
	notifyLine := fmt.Sprintf("notify = %q", codexNotifyCmd(stopURL))

	// Read existing config and replace/append the notify line, preserving other settings.
	var lines []string
	if data, err := os.ReadFile(configPath); err == nil {
		lines = strings.Split(string(data), "\n")
	}

	replaced := false
	for i, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "notify") {
			lines[i] = notifyLine
			replaced = true
			break
		}
	}
	if !replaced {
		lines = append(lines, notifyLine)
	}

	if err := os.WriteFile(configPath, []byte(strings.Join(lines, "\n")), 0644); err != nil {
		return fmt.Errorf("write codex config: %w", err)
	}

	logger.Debug(fmt.Sprintf("[provider/codex] Wrote notify hook to %s (port %d, agent %s)", configPath, hooksPort, agentID))
	return nil
}

// codexNotifyCmd returns a shell command that POSTs stdin (the codex JSON
// payload) to url. Unlike Gemini, codex does not require a JSON response.
func codexNotifyCmd(url string) string {
	if runtime.GOOS == "windows" {
		return fmt.Sprintf(`curl -sS -X POST "%s" -H "Content-Type: application/json" -d @- > NUL 2>&1`, url)
	}
	return fmt.Sprintf(`curl -sS -X POST "%s" -H "Content-Type: application/json" -d @- > /dev/null 2>&1`, url)
}

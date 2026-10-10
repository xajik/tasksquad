package provider

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/tasksquad/daemon/logger"
)

// Claw is the provider for the Claw Code CLI (command: agent, the
// agent-code crate).
//
// Completion is signalled via a stop hook written to
// <workDir>/.agent/settings.local.toml:
//   - stop hook → POST /hooks/stop (task finished)
//
// agent-code reads TOML only (.agent/settings.toml, then the gitignored
// settings.local.toml); an .agent/settings.json is never loaded, so hooks
// written there silently never fired. Its HTTP hooks POST an empty body.
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

func (p *Claw) ExtraArgs() []string                   { return nil }
func (p *Claw) SetupArgs(_ int, _, _ string) []string { return nil }

const (
	clawManagedStart = "# >>> TaskSquad hooks (managed by tsq; replaced on every task) >>>"
	clawManagedEnd   = "# <<< TaskSquad hooks <<<"
)

// Setup writes the TaskSquad hook block into .agent/settings.local.toml,
// replacing the block from a previous task and keeping anything else in
// the file. agent-code replaces arrays layer by layer, so these hooks shadow
// any hooks declared in the project's committed settings.toml.
func (p *Claw) Setup(workDir string, hooksPort int, agentID string, taskID string) error {
	settingsPath := filepath.Join(workDir, ".agent", "settings.local.toml")
	var b strings.Builder
	b.WriteString(clawManagedStart + "\n")
	clawHook(&b, "stop", "", fmt.Sprintf("http://localhost:%d/hooks/stop?agent=%s&task_id=%s", hooksPort, agentID, taskID))
	b.WriteString(clawManagedEnd + "\n")
	if err := writeManagedBlock(settingsPath, b.String()); err != nil {
		return err
	}
	logger.Debug(fmt.Sprintf("[provider/claw] Wrote hooks to %s (port %d)", settingsPath, hooksPort))
	return nil
}

// clawHook appends one [[hooks]] entry; toolName "" matches every tool.
func clawHook(b *strings.Builder, event, toolName, url string) {
	fmt.Fprintf(b, "[[hooks]]\nevent = %q\n", event)
	if toolName != "" {
		fmt.Fprintf(b, "tool_name = %q\n", toolName)
	}
	fmt.Fprintf(b, "action = { type = \"http\", url = %q }\n\n", url)
}

// writeManagedBlock replaces the text between the TaskSquad markers in path
// with block (appending it when absent), leaving the rest of the file intact.
func writeManagedBlock(path, block string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	rest := string(existing)
	if start := strings.Index(rest, clawManagedStart); start >= 0 {
		end := strings.Index(rest[start:], clawManagedEnd)
		if end < 0 {
			rest = rest[:start]
		} else {
			rest = rest[:start] + strings.TrimPrefix(rest[start+end+len(clawManagedEnd):], "\n")
		}
	}
	if rest != "" && !strings.HasSuffix(rest, "\n") {
		rest += "\n"
	}
	return os.WriteFile(path, []byte(rest+block), 0644)
}

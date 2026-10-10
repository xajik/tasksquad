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
//   - lifecycle + per-tool hooks → POST /hooks/event (session analytics)
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

// clawLifecycleEvents map agent-code hook events onto the names
// metrics.Lifecycle reads. Its hooks carry no payload, so the event (and
// tool) travel in the /hooks/event URL.
var clawLifecycleEvents = []struct{ native, canonical string }{
	{"session_start", "SessionStart"}, {"user_prompt_submit", "UserPromptSubmit"},
	{"stop", "Stop"}, {"pre_compact", "PreCompact"}, {"session_stop", "SessionEnd"},
}

// clawTools are agent-code 0.21's built-in tools. A body-less hook can only
// name its tool through the tool_name filter, so each gets its own pre/post
// pair; MCP and newer tools still appear via the session transcript.
var clawTools = []string{
	"Agent", "AskUserQuestion", "Bash", "Brief", "Config", "CronCreate", "CronDelete", "CronList",
	"EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree", "FileEdit", "FileRead", "FileWrite",
	"Glob", "Grep", "ListMcpResources", "LSP", "McpAuth", "Monitor", "MultiEdit", "NotebookEdit",
	"PowerShell", "ReadMcpResource", "RemoteTrigger", "REPL", "SendMessage", "Skill", "Sleep",
	"TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "TodoWrite",
	"ToolSearch", "WebFetch", "WebSearch",
}

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
	eventURL := fmt.Sprintf("http://localhost:%d/hooks/event?agent=%s&task_id=%s&provider=claw", hooksPort, agentID, taskID)
	for _, e := range clawLifecycleEvents {
		clawHook(&b, e.native, "", eventURL+"&event="+e.canonical)
	}
	for _, tool := range clawTools {
		clawHook(&b, "pre_tool_use", tool, eventURL+"&event=PreToolUse&tool="+tool)
		clawHook(&b, "post_tool_use", tool, eventURL+"&event=PostToolUse&tool="+tool)
	}
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

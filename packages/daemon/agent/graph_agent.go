package agent

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/tasksquad/daemon/provider"
)

// graphSubAgent maps an Action Graph role to the sub-agent identity published on the
// Skills & Sub-agents page. Roles without an identity (repair, reconcile) run as the plain CLI.
func graphSubAgent(role string) string {
	switch role {
	// Reconciliation inspects processes and external baselines; the read-only
	// grader identity cannot perform those checks. Use the configured CLI.
	case "grade", "project":
		return "tsq-graph-grader"
	case "execute", "undo", "continue":
		return "tsq-graph-executor"
	// Planning steps propose bounded actions and never execute them.
	case "decompose", "plan", "merge":
		return "tsq-graph-planner"
	}
	return ""
}

// graphAgentArgs starts Claude Code as the role's sub-agent (`claude --agent <name>`) so the
// identity and its tool limits apply to the whole session. It returns nil, and the task falls
// back to the worker's Skills-based instruction, when the CLI is not Claude Code or the
// sub-agent has not been installed in this work directory yet.
func graphAgentArgs(prov provider.Provider, task map[string]any, workDir string) []string {
	if prov.Name() != "claude-code" {
		return nil
	}
	graph, _ := task["graph"].(map[string]any)
	role, _ := graph["role"].(string)
	name := graphSubAgent(role)
	if name == "" {
		return nil
	}
	if _, err := os.Stat(filepath.Join(workDir, ".claude", "agents", name+".md")); err != nil {
		return nil
	}
	return []string{"--agent", name}
}

var frontmatter = regexp.MustCompile(`(?s)\A---\r?\n.*?\r?\n---\r?\n?`)

const maxIdentity = 1600

// graphIdentityText is the fallback for CLIs that cannot run as a sub-agent (or when the sub-agent
// is not installed as a Claude Code agent): the published identity is read from whichever harness
// directory the sync wrote it to and prepended to the prompt as plain text.
func graphIdentityText(task map[string]any, workDir string) string {
	graph, _ := task["graph"].(map[string]any)
	role, _ := graph["role"].(string)
	name := graphSubAgent(role)
	if name == "" {
		return ""
	}
	for _, base := range []string{".claude", ".agents", ".agent", ".gemini", ".pi", ".forge"} {
		data, err := os.ReadFile(filepath.Join(workDir, base, "agents", name+".md"))
		if err != nil {
			continue
		}
		text := strings.TrimSpace(frontmatter.ReplaceAllString(string(data), ""))
		if len(text) > maxIdentity {
			text = text[:maxIdentity] + "…"
		}
		return text
	}
	return ""
}

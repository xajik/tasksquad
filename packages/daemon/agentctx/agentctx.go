// Package agentctx resolves which configured agent a standalone `tsq`
// subcommand invocation belongs to.
//
// The running daemon always knows "which agent is this" from its in-memory
// state (it dispatches hooks by matching an agent ID or task ID carried in
// the hook URL). A one-off `tsq <subcommand>` process — e.g. `tsq memory
// push` or `tsq tags pull` run directly from inside an agent's own CLI
// session — has none of that: it's a fresh process with only the static
// config file and its current working directory. Since the daemon spawns
// each agent's CLI with cmd.Dir set to that agent's configured work_dir
// (see agent/lifecycle.go startTask), matching the current directory against
// each configured agent's work_dir is a reliable way to recover "which agent
// am I" without any daemon-process involvement.
package agentctx

import (
	"fmt"
	"path/filepath"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/config"
)

// CurrentAgentID returns the ID of the configured agent whose work_dir
// matches workDir, or "" if none matches (e.g. tsq was invoked outside any
// configured agent's work_dir).
func CurrentAgentID(cfg *config.Config, workDir string) string {
	workDir = filepath.Clean(workDir)
	for _, a := range cfg.Agents {
		if a.WorkDir != "" && filepath.Clean(a.WorkDir) == workDir {
			return a.ID
		}
	}
	return ""
}

// CurrentTeamID resolves the team ID for the agent whose work_dir matches
// workDir (see CurrentAgentID) via GET /daemon/user/agents — the existing
// endpoint `tsq init` already uses to discover a user's agents, whose
// response already carries each agent's team_id. This avoids needing any new
// worker endpoint just to answer "what team is this daemon's current agent
// on", since the daemon itself never stores team_id locally.
func CurrentTeamID(cfg *config.Config, token, workDir string) (string, error) {
	agentID := CurrentAgentID(cfg, workDir)
	if agentID == "" {
		return "", fmt.Errorf("current directory %q doesn't match any configured agent's work_dir", workDir)
	}

	resp, err := api.Get(cfg, token, "/daemon/user/agents")
	if err != nil {
		return "", fmt.Errorf("fetch agents: %w", err)
	}
	raw, _ := resp["agents"].([]any)
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if id, _ := m["id"].(string); id == agentID {
			if teamID, _ := m["team_id"].(string); teamID != "" {
				return teamID, nil
			}
			return "", fmt.Errorf("agent %s has no team_id in /daemon/user/agents response", agentID)
		}
	}
	return "", fmt.Errorf("agent %s not found in /daemon/user/agents response", agentID)
}

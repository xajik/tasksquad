// Package agents manages the synchronisation of sub-agent definitions between
// the TaskSquad server and each agent's work directory.
//
// Flow:
//   - StartSync (sync.go) polls the server hourly and installs auto_install /
//     default sub-agents into each agent's work directory.
//   - installAgent / removeAgent (install.go) manage on-disk .md files and
//     copy them to .claude/agents, .agents/agents, and .gemini/agents.
package agents

// AgentRef is the minimal interface this package needs from a running agent.
type AgentRef interface {
	AgentID() string
	WorkDir() string
}

// remoteAgent is the server-side sub-agent shape from GET /daemon/user/sub-agents.
type remoteAgent struct {
	ID          string
	TeamID      string
	Name        string
	Description string
	Content     string
	Etag        string
	Version     int
	IsDefault   int
	AutoInstall int
}

// agentsLock is the on-disk JSON structure tracking which sub-agents are installed.
// Key: agent name, value: etag.
type agentsLock map[string]string

// remoteAgentFromMap converts the raw map from the API response into a remoteAgent.
func remoteAgentFromMap(m map[string]any) remoteAgent {
	a := remoteAgent{}
	a.ID, _ = m["id"].(string)
	a.TeamID, _ = m["team_id"].(string)
	a.Name, _ = m["name"].(string)
	a.Description, _ = m["description"].(string)
	a.Content, _ = m["content"].(string)
	a.Etag, _ = m["etag"].(string)
	if v, ok := m["auto_install"].(float64); ok {
		a.AutoInstall = int(v)
	}
	if v, ok := m["is_default"].(float64); ok {
		a.IsDefault = int(v)
	}
	if v, ok := m["version"].(float64); ok {
		a.Version = int(v)
	}
	return a
}

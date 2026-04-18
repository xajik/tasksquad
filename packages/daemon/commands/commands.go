// Package commands manages the synchronisation of slash-command definitions
// between the TaskSquad server and each agent's work directory.
//
// Flow:
//   - StartSync (sync.go) polls the server hourly and installs auto_install /
//     default commands into each agent's work directory.
//   - installCommand / removeCommand (install.go) manage on-disk .md files and
//     copy them to every supported command directory:
//     .claude/commands, .agents/commands, .agent/commands,
//     .gemini/commands, .opencode/commands.
package commands

// AgentRef is the minimal interface this package needs from a running agent.
type AgentRef interface {
	AgentID() string
	WorkDir() string
}

// remoteCommand is the server-side command shape from GET /daemon/user/commands.
type remoteCommand struct {
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

// commandsLock is the on-disk JSON structure tracking which commands are installed.
// Key: command name, value: etag.
type commandsLock map[string]string

// remoteCommandFromMap converts the raw map from the API response into a remoteCommand.
func remoteCommandFromMap(m map[string]any) remoteCommand {
	c := remoteCommand{}
	c.ID, _ = m["id"].(string)
	c.TeamID, _ = m["team_id"].(string)
	c.Name, _ = m["name"].(string)
	c.Description, _ = m["description"].(string)
	c.Content, _ = m["content"].(string)
	c.Etag, _ = m["etag"].(string)
	if v, ok := m["auto_install"].(float64); ok {
		c.AutoInstall = int(v)
	}
	if v, ok := m["is_default"].(float64); ok {
		c.IsDefault = int(v)
	}
	if v, ok := m["version"].(float64); ok {
		c.Version = int(v)
	}
	return c
}

// Package skills manages the extraction and synchronisation of reusable agent
// learnings (skills) between sessions and the TaskSquad server.
//
// Flow:
//   - After a session closes, ExtractFromSession (extract.go) runs the local
//     CLI to identify learnings and uploads them to the server.
//   - StartSync (sync.go) polls the server hourly and installs auto_install /
//     default skills into each agent's work directory.
//   - installSkill / removeSkill (install.go) manage on-disk files and symlinks.
package skills

// AgentRef is the minimal interface this package needs from an agent.
type AgentRef interface {
	AgentID() string
	WorkDir() string
}

// remoteSkill is the server-side skill shape from GET /daemon/user/skills.
type remoteSkill struct {
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

// skillsLock is the on-disk JSON structure tracking which skills are installed.
// Key: skill name, value: etag.
type skillsLock map[string]string

// skillPayload is the structured JSON response we request from the agent CLI.
type skillPayload struct {
	Skills []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Content     string `json:"content"`
	} `json:"skills"`
}

// remoteSkillFromMap converts the raw map from the API response into a remoteSkill.
func remoteSkillFromMap(m map[string]any) remoteSkill {
	s := remoteSkill{}
	s.ID, _ = m["id"].(string)
	s.TeamID, _ = m["team_id"].(string)
	s.Name, _ = m["name"].(string)
	s.Description, _ = m["description"].(string)
	s.Content, _ = m["content"].(string)
	s.Etag, _ = m["etag"].(string)
	if v, ok := m["auto_install"].(float64); ok {
		s.AutoInstall = int(v)
	}
	if v, ok := m["is_default"].(float64); ok {
		s.IsDefault = int(v)
	}
	if v, ok := m["version"].(float64); ok {
		s.Version = int(v)
	}
	return s
}

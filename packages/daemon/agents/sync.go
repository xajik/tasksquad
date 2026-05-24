package agents

import (
	"fmt"
	"time"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/harness"
	"github.com/tasksquad/daemon/logger"
)

// Syncer allows external code to trigger an immediate sub-agents sync.
type Syncer struct {
	triggerCh chan struct{}
}

// NewSyncer creates a Syncer.
func NewSyncer() *Syncer {
	return &Syncer{triggerCh: make(chan struct{}, 1)}
}

// ForceSync triggers an immediate sub-agents sync (non-blocking; no-op if already pending).
func (s *Syncer) ForceSync() {
	select {
	case s.triggerCh <- struct{}{}:
	default:
	}
}

// StartSync polls the server every hour for auto_install sub-agents and syncs them
// to each agent's work directory. Safe to call in a goroutine.
func StartSync(cfg *config.Config, agents []AgentRef, syncer *Syncer) {
	if cfg == nil || len(agents) == 0 {
		return
	}
	logger.Info("[agents] Sub-agent sync started (interval=1h)")
	syncAgents(cfg, agents) // immediate sync on startup
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			syncAgents(cfg, agents)
		case <-syncer.triggerCh:
			logger.Info("[agents] force-sync triggered")
			syncAgents(cfg, agents)
		}
	}
}

func syncAgents(cfg *config.Config, agents []AgentRef) {
	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		logger.Error(fmt.Sprintf("[agents] Sync auth failed: %v", err))
		return
	}

	seen := map[string]bool{}
	for _, a := range agents {
		wd := a.WorkDir()
		if wd == "" || seen[wd] {
			continue
		}
		seen[wd] = true
		syncWorkDir(cfg, token, a.AgentID(), wd)
	}
}

func syncWorkDir(cfg *config.Config, token, agentID, workDir string) {
	resp, err := api.Get(cfg, token, "/daemon/user/sub-agents?agent_id="+agentID)
	if err != nil {
		logger.Error(fmt.Sprintf("[agents] Sync fetch failed for agent %s: %v", agentID, err))
		return
	}

	raw, _ := resp["sub_agents"].([]any)
	lock := loadLock(workDir)
	serverNames := map[string]bool{}
	installed, removed := 0, 0

	if len(raw) > 0 {
		logger.Debug(fmt.Sprintf("[agents] Sync found %d potential sub-agents for agent %s", len(raw), agentID))
	}

	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		agent := remoteAgentFromMap(m)
		if agent.AutoInstall == 0 && agent.IsDefault == 0 {
			continue
		}
		serverNames[agent.Name] = true

		agentFile := fmt.Sprintf("%s/.tsq/agents/%s.md", workDir, agent.Name)
		if lock[agent.Name] == agent.Etag && agent.Etag != "" {
			if harness.FileExists(agentFile) {
				continue // already up to date
			}
		}

		// Fetch full content if not in list response.
		if agent.Content == "" && agent.ID != "" {
			var path string
			if agent.TeamID != "" {
				path = fmt.Sprintf("/teams/%s/sub-agents/%s", agent.TeamID, agent.ID)
			} else {
				path = fmt.Sprintf("/daemon/sub-agents/%s", agent.ID)
			}
			full, err := api.GetConditional(cfg, token, path, lock[agent.Name])
			if err != nil {
				logger.Error(fmt.Sprintf("[agents] Failed to fetch sub-agent %q content: %v", agent.Name, err))
				continue
			}
			if full == nil {
				serverNames[agent.Name] = true
				continue
			}
			agent.Content, _ = full["content"].(string)
			if e, ok := full["etag"].(string); ok && e != "" {
				agent.Etag = e
			}
		}

		if agent.Content == "" {
			logger.Warn(fmt.Sprintf("[agents] Skipping %q — no content received", agent.Name))
			continue
		}

		if err := installAgent(workDir, agent); err != nil {
			logger.Error(fmt.Sprintf("[agents] Failed to install %q: %v", agent.Name, err))
			continue
		}
		lock[agent.Name] = agent.Etag
		logger.Info(fmt.Sprintf("[agents] Installed sub-agent %q v%d → %s", agent.Name, agent.Version, workDir))
		installed++
	}

	// Remove sub-agents that were deleted on the server.
	for name := range lock {
		if !serverNames[name] {
			removeAgent(workDir, name)
			delete(lock, name)
			logger.Info(fmt.Sprintf("[agents] Removed sub-agent %q from %s (deleted on server)", name, workDir))
			removed++
		}
	}

	saveLock(workDir, lock)

	if installed+removed > 0 {
		logger.Info(fmt.Sprintf("[agents] Sync complete for agent %s: %d installed, %d removed", agentID, installed, removed))
	} else {
		logger.Debug(fmt.Sprintf("[agents] Sync complete for agent %s: all up to date", agentID))
	}
}

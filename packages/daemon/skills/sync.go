package skills

import (
	"fmt"
	"time"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/harness"
	"github.com/tasksquad/daemon/logger"
)

// Syncer allows external code to trigger an immediate skills sync.
type Syncer struct {
	triggerCh chan struct{}
}

// NewSyncer creates a Syncer.
func NewSyncer() *Syncer {
	return &Syncer{triggerCh: make(chan struct{}, 1)}
}

// ForceSync triggers an immediate skills sync (non-blocking; no-op if already pending).
func (s *Syncer) ForceSync() {
	select {
	case s.triggerCh <- struct{}{}:
	default:
	}
}

// StartSync polls the server every hour for auto_install skills and syncs them
// to each agent's work directory. Safe to call in a goroutine.
func StartSync(cfg *config.Config, agents []AgentRef, syncer *Syncer) {
	if cfg == nil || len(agents) == 0 {
		return
	}
	logger.Info("[skills] Auto-install sync started (interval=1h)")
	syncSkills(cfg, agents) // immediate sync on startup
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			syncSkills(cfg, agents)
		case <-syncer.triggerCh:
			logger.Info("[skills] force-sync triggered")
			syncSkills(cfg, agents)
		}
	}
}

func syncSkills(cfg *config.Config, agents []AgentRef) {
	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		logger.Error(fmt.Sprintf("[skills] Sync auth failed: %v", err))
		return
	}

	seen := map[string]bool{}
	for _, a := range agents {
		wd := a.WorkDir()
		if wd == "" || seen[wd] {
			continue
		}
		seen[wd] = true
		syncAgentSkills(cfg, token, a.AgentID(), wd)
	}
}

func syncAgentSkills(cfg *config.Config, token, agentID, workDir string) {
	resp, err := api.Get(cfg, token, "/daemon/user/skills?agent_id="+agentID)
	if err != nil {
		logger.Error(fmt.Sprintf("[skills] Sync fetch failed for agent %s: %v", agentID, err))
		return
	}

	raw, _ := resp["skills"].([]any)
	lock := loadLock(workDir)
	serverNames := map[string]bool{}

	if len(raw) > 0 {
		logger.Debug(fmt.Sprintf("[skills] Sync found %d potential skills for agent %s", len(raw), agentID))
	}

	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		skill := remoteSkillFromMap(m)
		if skill.AutoInstall == 0 && skill.IsDefault == 0 {
			continue
		}
		serverNames[skill.Name] = true

		if lock[skill.Name] == skill.Etag && skill.Etag != "" {
			skillDir := skillDir(workDir, skill.Name)
			if harness.FileExists(skillDir + "/SKILL.md") {
				continue // already up to date and exists on disk
			}
		}

		// Fetch full content if not in list response.
		if skill.Content == "" && skill.ID != "" {
			var path string
			if skill.TeamID != "" {
				path = fmt.Sprintf("/teams/%s/skills/%s", skill.TeamID, skill.ID)
			} else {
				path = fmt.Sprintf("/daemon/skills/%s", skill.ID)
			}
			full, err := api.GetConditional(cfg, token, path, lock[skill.Name])
			if err != nil {
				logger.Error(fmt.Sprintf("[skills] Failed to fetch skill %q content: %v", skill.Name, err))
				continue
			}
			if full == nil {
				serverNames[skill.Name] = true
				continue
			}
			skill.Content, _ = full["content"].(string)
			if e, ok := full["etag"].(string); ok && e != "" {
				skill.Etag = e
			}
		}

		if skill.Content == "" {
			logger.Warn(fmt.Sprintf("[skills] Skipping %q — no content received", skill.Name))
			continue
		}

		if err := installSkill(workDir, skill); err != nil {
			logger.Error(fmt.Sprintf("[skills] Failed to install %q: %v", skill.Name, err))
			continue
		}
		lock[skill.Name] = skill.Etag
		logger.Info(fmt.Sprintf("[skills] Installed %q v%d → %s", skill.Name, skill.Version, workDir))
	}

	// Remove skills that were deleted on the server.
	for name := range lock {
		if !serverNames[name] {
			removeSkill(workDir, name)
			delete(lock, name)
			logger.Info(fmt.Sprintf("[skills] Removed %q from %s (deleted on server)", name, workDir))
		}
	}

	saveLock(workDir, lock)
}

package commands

import (
	"fmt"
	"time"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/harness"
	"github.com/tasksquad/daemon/logger"
)

type Syncer struct {
	triggerCh chan struct{}
}

func NewSyncer() *Syncer {
	return &Syncer{triggerCh: make(chan struct{}, 1)}
}

func (s *Syncer) ForceSync() {
	select {
	case s.triggerCh <- struct{}{}:
	default:
	}
}

func StartSync(cfg *config.Config, agents []AgentRef, syncer *Syncer) {
	if cfg == nil || len(agents) == 0 {
		return
	}
	logger.Info("[commands] Auto-install sync started (interval=1h)")
	syncCommands(cfg, agents) // immediate sync on startup
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			syncCommands(cfg, agents)
		case <-syncer.triggerCh:
			logger.Info("[commands] force-sync triggered")
			syncCommands(cfg, agents)
		}
	}
}

func syncCommands(cfg *config.Config, agents []AgentRef) {
	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		logger.Error(fmt.Sprintf("[commands] Sync auth failed: %v", err))
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
	resp, err := api.Get(cfg, token, "/daemon/user/commands?agent_id="+agentID)
	if err != nil {
		logger.Error(fmt.Sprintf("[commands] Sync fetch failed for agent %s: %v", agentID, err))
		return
	}

	raw, _ := resp["commands"].([]any)
	lock := loadLock(workDir)
	serverNames := map[string]bool{}
	installed, removed := 0, 0

	if len(raw) > 0 {
		logger.Debug(fmt.Sprintf("[commands] Sync found %d potential commands for agent %s", len(raw), agentID))
	}

	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		cmd := remoteCommandFromMap(m)
		if cmd.AutoInstall == 0 && cmd.IsDefault == 0 {
			continue
		}
		serverNames[cmd.Name] = true

		cmdFile := fmt.Sprintf("%s/.tsq/commands/%s.md", workDir, cmd.Name)
		if lock[cmd.Name] == cmd.Etag && cmd.Etag != "" {
			if harness.FileExists(cmdFile) {
				continue // already up to date
			}
		}

		if cmd.Content == "" && cmd.ID != "" {
			var path string
			if cmd.TeamID != "" {
				path = fmt.Sprintf("/teams/%s/commands/%s", cmd.TeamID, cmd.ID)
			} else {
				path = fmt.Sprintf("/daemon/commands/%s", cmd.ID)
			}
			full, err := api.GetConditional(cfg, token, path, lock[cmd.Name])
			if err != nil {
				logger.Error(fmt.Sprintf("[commands] Failed to fetch command %q content: %v", cmd.Name, err))
				continue
			}
			if full == nil {
				serverNames[cmd.Name] = true
				continue
			}
			cmd.Content, _ = full["content"].(string)
			if e, ok := full["etag"].(string); ok && e != "" {
				cmd.Etag = e
			}
		}

		if cmd.Content == "" {
			logger.Warn(fmt.Sprintf("[commands] Skipping %q — no content received", cmd.Name))
			continue
		}

		if err := installCommand(workDir, cmd); err != nil {
			logger.Error(fmt.Sprintf("[commands] Failed to install %q: %v", cmd.Name, err))
			continue
		}
		lock[cmd.Name] = cmd.Etag
		logger.Info(fmt.Sprintf("[commands] Installed %q v%d → %s", cmd.Name, cmd.Version, workDir))
		installed++
	}

	for name := range lock {
		if !serverNames[name] {
			removeCommand(workDir, name)
			delete(lock, name)
			logger.Info(fmt.Sprintf("[commands] Removed %q from %s (deleted on server)", name, workDir))
			removed++
		}
	}

	saveLock(workDir, lock)

	if installed+removed > 0 {
		logger.Info(fmt.Sprintf("[commands] Sync complete for agent %s: %d installed, %d removed", agentID, installed, removed))
	} else {
		logger.Debug(fmt.Sprintf("[commands] Sync complete for agent %s: all up to date", agentID))
	}
}

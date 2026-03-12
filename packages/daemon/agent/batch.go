package agent

import (
	"fmt"
	"time"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

// RunBatch replaces N independent Run() goroutines with a single poll loop that
// sends one POST /daemon/heartbeat/batch request per interval carrying all agent
// tokens. It uses a combined ETag so the server can return 304 when all agents
// are idle and nothing has changed.
func RunBatch(cfg *config.Config, agents []*Agent) {
	ticker := time.NewTicker(time.Duration(cfg.Server.PollInterval) * time.Second)
	defer ticker.Stop()

	var combinedEtag string

	do := func() {
		// Build the per-agent entry list (token + current status).
		entries := make([]map[string]any, len(agents))
		for i, a := range agents {
			a.mu.Lock()
			mode := a.mode
			a.mu.Unlock()
			entries[i] = map[string]any{"token": a.Config.Token, "status": string(mode)}
		}

		agentMaps, newEtag, is304, err := api.PostBatch(cfg, "/daemon/heartbeat/batch", entries, combinedEtag)
		if err != nil {
			logger.Error(fmt.Sprintf("[batch] Heartbeat failed: %v", err))
			return
		}
		if is304 {
			logger.Debug("[batch] 304 — inbox unchanged, all agents idle")
			return
		}

		combinedEtag = newEtag

		// Match responses to agents by position (request order == response order).
		for i, item := range agentMaps {
			if i >= len(agents) {
				break
			}
			a := agents[i]
			a.mu.Lock()
			a.lastPollAt = time.Now()
			a.mu.Unlock()
			a.processResponse(cfg, item)
		}
	}

	do() // immediate first poll
	for range ticker.C {
		do()
	}
}

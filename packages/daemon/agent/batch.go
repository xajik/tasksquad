package agent

import (
	"fmt"
	"strings"
	"time"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

// RunBatch replaces N independent Run() goroutines with a single poll loop that
// sends one POST /daemon/heartbeat/batch request per interval carrying all agent
// IDs and statuses. A combined ETag lets the server return 304 when all agents
// are idle and nothing has changed.
//
// On a 401 response the loop automatically rotates the token once via
// ForceRotate and retries. If rotation also fails, it logs the error and waits
// for the next interval (user sees a log message to run: tsq login).
func RunBatch(cfg *config.Config, agents []*Agent) {
	ticker := time.NewTicker(time.Duration(cfg.Server.PollInterval) * time.Second)
	defer ticker.Stop()

	var combinedEtag string

	do := func() {
		token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
		if err != nil {
			logger.Error(fmt.Sprintf("[batch] auth error: %v", err))
			return
		}

		// Build per-agent entry list.
		entries := make([]map[string]any, len(agents))
		for i, a := range agents {
			a.mu.Lock()
			mode := a.mode
			a.mu.Unlock()
			entries[i] = map[string]any{"id": a.Config.ID, "status": string(mode)}
		}

		agentMaps, newEtag, is304, err := api.PostBatch(cfg, token, "/daemon/heartbeat/batch", entries, combinedEtag)
		if err != nil {
			// On 401 (invalid/expired token) attempt a one-time force rotation and retry.
			if isUnauthorized(err) {
				logger.Warn("[batch] received 401 — rotating token and retrying once...")
				newToken, rotErr := auth.ForceRotate(cfg.Firebase.APIKey, cfg.Server.URL)
				if rotErr != nil {
					logger.Error(fmt.Sprintf("[batch] token rotation failed: %v", rotErr))
					logger.Error("[batch] run: tsq login to re-authenticate")
					return
				}
				agentMaps, newEtag, is304, err = api.PostBatch(cfg, newToken, "/daemon/heartbeat/batch", entries, combinedEtag)
				if err != nil {
					logger.Error(fmt.Sprintf("[batch] heartbeat failed after token rotation: %v", err))
					if isUnauthorized(err) {
						logger.Error("[batch] run: tsq login to re-authenticate")
					}
					return
				}
			} else {
				logger.Error(fmt.Sprintf("[batch] heartbeat failed: %v", err))
				return
			}
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

// isUnauthorized returns true when the API error indicates a 401 response.
func isUnauthorized(err error) bool {
	return strings.Contains(err.Error(), "HTTP 401")
}

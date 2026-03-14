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

// RunBatch polls the server in a loop driven by the server-returned next_poll_ms
// value (from the response body). On the first poll and as fallback,
// cfg.Server.PollInterval is used. A combined ETag lets the server return 304
// when all agents are idle and nothing has changed.
//
// On 429 the daemon simply waits the normal interval and retries — rate limiting
// is enforced server-side; no client-side backoff is applied.
//
// On 401 the loop rotates the token once via ForceRotate and retries.
func RunBatch(cfg *config.Config, agents []*Agent) {
	nextInterval := time.Duration(cfg.Server.PollInterval) * time.Second
	timer := time.NewTimer(0) // fire immediately for first poll
	defer timer.Stop()

	var combinedEtag string

	for range timer.C {
		token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
		if err != nil {
			logger.Error(fmt.Sprintf("[batch] auth error: %v", err))
			timer.Reset(nextInterval)
			continue
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
			if isRateLimited(err) {
				logger.Warn("[batch] rate limited (429) — retrying after normal interval")
				timer.Reset(nextInterval)
				continue
			}
			if isUnauthorized(err) {
				logger.Warn("[batch] received 401 — rotating token and retrying once...")
				newToken, rotErr := auth.ForceRotate(cfg.Firebase.APIKey, cfg.Server.URL)
				if rotErr != nil {
					logger.Error(fmt.Sprintf("[batch] token rotation failed: %v", rotErr))
					logger.Error("[batch] run: tsq login to re-authenticate")
					timer.Reset(nextInterval)
					continue
				}
				agentMaps, newEtag, is304, err = api.PostBatch(cfg, newToken, "/daemon/heartbeat/batch", entries, combinedEtag)
				if err != nil {
					logger.Error(fmt.Sprintf("[batch] heartbeat failed after token rotation: %v", err))
					if isUnauthorized(err) {
						logger.Error("[batch] run: tsq login to re-authenticate")
					}
					timer.Reset(nextInterval)
					continue
				}
			} else {
				logger.Error(fmt.Sprintf("[batch] heartbeat failed: %v", err))
				timer.Reset(nextInterval)
				continue
			}
		}

		if is304 {
			logger.Debug("[batch] 304 — inbox unchanged, all agents idle")
			timer.Reset(nextInterval)
			continue
		}

		combinedEtag = newEtag

		// Update poll interval from server-provided hint (first agent carries it).
		if len(agentMaps) > 0 {
			if ms, ok := agentMaps[0]["next_poll_ms"].(float64); ok && ms > 0 {
				nextInterval = time.Duration(ms) * time.Millisecond
			}
		}

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

		timer.Reset(nextInterval)
	}
}

// isUnauthorized returns true when the API error indicates a 401 response.
func isUnauthorized(err error) bool {
	return strings.Contains(err.Error(), "HTTP 401")
}

// isRateLimited returns true when the API error indicates a 429 response.
func isRateLimited(err error) bool {
	return strings.Contains(err.Error(), "HTTP 429")
}


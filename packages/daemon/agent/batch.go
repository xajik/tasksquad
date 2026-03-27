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

// BatchController allows external code to trigger an immediate poll.
type BatchController struct {
	triggerCh chan struct{}
}

// NewBatchController creates a BatchController.
func NewBatchController() *BatchController {
	return &BatchController{triggerCh: make(chan struct{}, 1)}
}

// ForcePoll triggers an immediate heartbeat poll (non-blocking; no-op if already pending).
func (c *BatchController) ForcePoll() {
	select {
	case c.triggerCh <- struct{}{}:
	default:
	}
}

// RunBatch polls the server in a loop driven by the server-returned next_poll_ms
// value (from the response body). On the first poll and as fallback,
// cfg.Server.PollInterval is used. A combined ETag lets the server return 304
// when all agents are idle and nothing has changed.
//
// On 429 the daemon applies exponential backoff (30s base, 5m cap) to avoid
// hammering the server. Backoff resets on the next successful or 304 response.
//
// On 401 the loop rotates the token once via ForceRotate and retries.
func RunBatch(cfg *config.Config, agents []*Agent, ctrl *BatchController) {
	nextInterval := time.Duration(cfg.Server.PollInterval) * time.Second
	timer := time.NewTimer(0) // fire immediately for first poll
	defer timer.Stop()

	var combinedEtag string

	const (
		rateLimitBase = 30 * time.Second
		rateLimitMax  = 5 * time.Minute
	)
	var rateLimitBackoff time.Duration

	doPoll := func() {
		token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
		if err != nil {
			logger.Error(fmt.Sprintf("[batch] auth error: %v", err))
			timer.Reset(nextInterval)
			return
		}

		// Build per-agent entry list.
		entries := make([]map[string]any, len(agents))
		for i, a := range agents {
			entries[i] = map[string]any{"id": a.Config.ID, "status": a.st.Mode()}
		}

		agentMaps, newEtag, is304, err := api.PostBatch(cfg, token, "/daemon/heartbeat/batch", entries, combinedEtag)
		if err != nil {
			if isRateLimited(err) {
				if rateLimitBackoff == 0 {
					rateLimitBackoff = rateLimitBase
				} else {
					rateLimitBackoff *= 2
					if rateLimitBackoff > rateLimitMax {
						rateLimitBackoff = rateLimitMax
					}
				}
				logger.Warn(fmt.Sprintf("[batch] rate limited (429) — backing off %s", rateLimitBackoff))
				timer.Reset(rateLimitBackoff)
				return
			}
			if isUnauthorized(err) {
				logger.Warn("[batch] received 401 — rotating token and retrying once...")
				newToken, rotErr := auth.ForceRotate(cfg.Firebase.APIKey, cfg.Server.URL)
				if rotErr != nil {
					logger.Error(fmt.Sprintf("[batch] token rotation failed: %v", rotErr))
					logger.Error("[batch] run: tsq login to re-authenticate")
					timer.Reset(nextInterval)
					return
				}
				agentMaps, newEtag, is304, err = api.PostBatch(cfg, newToken, "/daemon/heartbeat/batch", entries, combinedEtag)
				if err != nil {
					logger.Error(fmt.Sprintf("[batch] heartbeat failed after token rotation: %v", err))
					if isUnauthorized(err) {
						logger.Error("[batch] run: tsq login to re-authenticate")
					}
					timer.Reset(nextInterval)
					return
				}
			} else {
				logger.Error(fmt.Sprintf("[batch] heartbeat failed: %v", err))
				timer.Reset(nextInterval)
				return
			}
		}

		if is304 {
			logger.Debug("[batch] 304 — inbox unchanged, all agents idle")
			rateLimitBackoff = 0
			timer.Reset(nextInterval)
			return
		}

		rateLimitBackoff = 0
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
			a.st.mu.Lock()
			a.st.lastPollAt = time.Now()
			a.st.mu.Unlock()
			a.processResponse(cfg, item)
		}

		timer.Reset(nextInterval)
	}

	for {
		select {
		case <-timer.C:
			doPoll()
		case <-ctrl.triggerCh:
			// Force-poll: drain pending timer tick to avoid a double poll.
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			logger.Info("[batch] force-poll triggered")
			doPoll()
		}
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

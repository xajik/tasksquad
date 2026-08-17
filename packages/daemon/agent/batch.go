package agent

import (
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/tasksquad/daemon/analytics"
	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

// daemonStartedAt records when this daemon process started so the server can
// apply a grace period before treating a 'running' portal as crashed on restart.
var daemonStartedAt = time.Now()

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
		uptimeMs := time.Since(daemonStartedAt).Milliseconds()
		entries := make([]map[string]any, len(agents))
		for i, a := range agents {
			entry := map[string]any{
				"id":               a.Config.ID,
				"status":           a.st.Mode(),
				"daemon_uptime_ms": uptimeMs,
			}
			if a.st.ModeValue() == ModeLearning {
				_, executed := a.st.CloseSteps()
				entry["close_step_idx"] = len(executed)
			}
			if atomic.LoadInt32(&a.portalActive) == 1 {
				entry["portal_active"] = true
			}
			if taskID := a.st.TaskID(); taskID != "" {
				entry["task_id"] = taskID
				entry["tui_blocked"] = a.st.TUIBlocked()
			}
			entries[i] = entry
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
				analytics.Track("task_poll_rate_limited", map[string]interface{}{
					"backoff_ms": rateLimitBackoff.Milliseconds(),
				})
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
						analytics.Track("task_poll_auth_failed", nil)
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

			// Portal assigned by server in batch response (idle agents only).
			if portalRaw, ok := item["portal"]; ok && portalRaw != nil {
				if pMap, ok2 := portalRaw.(map[string]any); ok2 {
					if id, _ := pMap["id"].(string); id != "" && a.st.ModeValue() == ModeIdle {
						go a.handlePortal(cfg, &portalRecord{id: id})
					}
				}
			}

			// Close signal: browser closed the portal or crash recovery (agent idle, portal 'running').
			if cpRaw, ok := item["close_portal"]; ok && cpRaw != nil {
				if cpMap, ok2 := cpRaw.(map[string]any); ok2 {
					if id, _ := cpMap["id"].(string); id != "" {
						crashed, _ := cpMap["crashed"].(bool)
						if atomic.LoadInt32(&a.portalActive) == 1 {
							// Portal goroutine is alive — deliver signal so it kills tmux.
							select {
							case a.portalSignals <- id:
							default:
							}
						} else {
							// No running goroutine (daemon was restarted / crashed).
							// Report the portal as closed so the server can mark it terminal.
							closeStatus := "done"
							if crashed {
								closeStatus = "failed"
							}
							logger.Info(fmt.Sprintf("[batch] portal %s: crash recovery — reporting %s", id, closeStatus))
							go a.reportPortalClose(cfg, id, closeStatus)
						}
					}
				}
			}
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

package orphan

import (
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/tasksquad/daemon/agentmode"
	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/tmux"
)

const orphanCleanupInterval = 1 * time.Hour

type SessionState struct {
	TaskID        string `json:"task_id"`
	TaskStatus    string `json:"task_status"`
	SessionStatus string `json:"session_status"`
}

type OrphanController struct {
	cfg          *config.Config
	token        string
	interval     time.Duration
	cachedStates map[string]SessionState
}

func New(cfg *config.Config, token string) *OrphanController {
	return &OrphanController{
		cfg:          cfg,
		token:        token,
		interval:     orphanCleanupInterval,
		cachedStates: make(map[string]SessionState),
	}
}

func (c *OrphanController) Run() {
	c.cleanOrphans()

	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	for range ticker.C {
		c.cleanOrphans()
	}
}

func (c *OrphanController) cleanOrphans() {
	sessionIDs, err := c.listTmuxSessions()
	if err != nil {
		logger.Warn(fmt.Sprintf("[orphan] failed to list tmux sessions: %v", err))
		return
	}
	if len(sessionIDs) == 0 {
		logger.Debug("[orphan] no tsq-* sessions found")
		return
	}

	logger.Info(fmt.Sprintf("[orphan] checking %d sessions", len(sessionIDs)))

	states, err := c.getSessionStates(sessionIDs)
	if err != nil {
		logger.Error(fmt.Sprintf("[orphan] failed to get session states: %v", err))
		return
	}

	for _, sid := range sessionIDs {
		state, exists := states[sid]
		// No state = session not in DB = orphan (deleted externally)
		// Or task_status is done/failed = orphan
		if !exists || c.isOrphan(state) {
			c.killOrphan(sid)
		}
	}

	logger.Info(fmt.Sprintf("[orphan] cleanup complete: %d sessions checked", len(sessionIDs)))
}

func (c *OrphanController) listTmuxSessions() ([]string, error) {
	out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").Output()
	if err != nil {
		return nil, nil
	}

	var ids []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name := strings.TrimSpace(line)
		if !strings.HasPrefix(name, "tsq-") || strings.HasPrefix(name, "tsq-sup-") {
			continue
		}
		ids = append(ids, strings.TrimPrefix(name, "tsq-"))
	}
	return ids, nil
}

func (c *OrphanController) getSessionStates(sessionIDs []string) (map[string]SessionState, error) {
	body := map[string]any{"sessions": sessionIDs}
	result, err := api.Post(c.cfg, c.token, "", "/daemon/session/state", body)
	if err != nil {
		return nil, err
	}

	states := make(map[string]SessionState)
	if rawStates, ok := result["states"].(map[string]any); ok {
		for sid, s := range rawStates {
			if m, ok := s.(map[string]any); ok {
				tid, _ := m["task_id"].(string)
				ts, _ := m["task_status"].(string)
				ss, _ := m["session_status"].(string)
				states[sid] = SessionState{
					TaskID:        tid,
					TaskStatus:    ts,
					SessionStatus: ss,
				}
			}
		}
	}

	c.cachedStates = states
	return states, nil
}

func (c *OrphanController) isOrphan(state SessionState) bool {
	return state.TaskStatus == string(agentmode.TaskStatusDone) || state.TaskStatus == string(agentmode.TaskStatusFailed)
}

func (c *OrphanController) killOrphan(sessionID string) {
	sessionName := "tsq-" + sessionID
	if err := tmux.KillSession(sessionName); err != nil {
		logger.Debug(fmt.Sprintf("[orphan] kill-session %s: %v", sessionName, err))
	}
	logger.Info(fmt.Sprintf("[orphan] killed orphaned session: %s", sessionName))

	// Also kill supervisor if task_id known
	state, hasState := c.cachedStates[sessionID]
	if hasState && state.TaskID != "" {
		supSession := "tsq-sup-" + state.TaskID
		if tmux.HasSession(supSession) {
			if err := tmux.KillSession(supSession); err != nil {
				logger.Debug(fmt.Sprintf("[orphan] kill-session %s: %v", supSession, err))
			}
			logger.Info(fmt.Sprintf("[orphan] killed orphaned supervisor: %s", supSession))
		}
	}
}

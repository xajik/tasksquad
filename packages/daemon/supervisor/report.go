package supervisor

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/tmux"
)

// waitForVerdictOrKill waits for the supervisor agent to POST /hooks/supervisor
// (delivered via HandleVerdict), the session to die naturally, or the timeout.
// Returns the verdict and whether one was received.
func (s *Supervisor) waitForVerdictOrKill(taskID, sessionName string) (supervisorVerdict, bool) {
	ch := make(chan supervisorVerdict, 1)
	s.mu.Lock()
	s.verdictChans[taskID] = ch
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.verdictChans, taskID)
		s.mu.Unlock()
	}()

	deadline := time.NewTimer(supervisorTimeout)
	defer deadline.Stop()
	checkTicker := time.NewTicker(sessionCheckInterval)
	defer checkTicker.Stop()

	for {
		select {
		case v := <-ch:
			// Verdict delivered via /hooks/supervisor — kill session and return.
			time.Sleep(500 * time.Millisecond) // let output flush
			logKill(sessionName, tmux.KillSession(sessionName))
			return v, true

		case <-deadline.C:
			logKill(sessionName, tmux.KillSession(sessionName))
			logger.Warn(fmt.Sprintf("[supervisor] Session %s timed out after %s", sessionName, supervisorTimeout))
			return supervisorVerdict{}, false

		case <-checkTicker.C:
			// Print mode: CLI process exits when done, killing the tmux session.
			if !tmux.HasSession(sessionName) {
				logger.Warn(fmt.Sprintf("[supervisor] Session %s: process exited without calling /hooks/supervisor", sessionName))
				return supervisorVerdict{}, false
			}
		}
	}
}

// cleanOrphans scans tmux for tsq-sup-* sessions that are not actively managed
// by the current daemon run (left over from previous runs or crashes) and kills them.
func (s *Supervisor) cleanOrphans() {
	out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").Output()
	if err != nil {
		return // tmux not running or no sessions
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name := strings.TrimSpace(line)
		if !strings.HasPrefix(name, "tsq-sup-") {
			continue
		}
		suffix := strings.TrimPrefix(name, "tsq-sup-")
		isActive := false
		for taskID := range s.activeForTask {
			taskSuffix := taskID
			if len(taskSuffix) > 8 {
				taskSuffix = taskSuffix[:8]
			}
			if taskSuffix == suffix {
				isActive = true
				break
			}
		}
		if !isActive {
			logKill(name, tmux.KillSession(name))
			logger.Info(fmt.Sprintf("[supervisor] Orphan cleanup: killed %s", name))
		}
	}
}

// appendToLog appends text to a file, ignoring errors.
func appendToLog(path, text string) {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprint(f, text) //nolint:errcheck
}

// reportToWorker posts a supervisor message to the task inbox via the daemon API.
func (s *Supervisor) reportToWorker(taskID, agentID, body string) {
	if s.cfg == nil {
		return
	}
	token, err := auth.GetToken(s.cfg.Firebase.APIKey, s.cfg.Server.URL)
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Auth failed for report (task %s): %v", taskID, err))
		return
	}
	_, err = api.Post(s.cfg, token, agentID, "/daemon/supervisor/report", map[string]any{
		"task_id": taskID,
		"body":    body,
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Failed to post report for task %s: %v", taskID, err))
		return
	}
	logger.Info(fmt.Sprintf("[supervisor] Report posted for task %s (%d chars)", taskID, len(body)))
}

// notifyProgress posts a minimal "running well" progress message to the task inbox.
func (s *Supervisor) notifyProgress(taskID, agentID, message string) {
	if s.cfg == nil {
		return
	}
	token, err := auth.GetToken(s.cfg.Firebase.APIKey, s.cfg.Server.URL)
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Auth failed for progress (task %s): %v", taskID, err))
		return
	}
	_, err = api.Post(s.cfg, token, agentID, "/daemon/supervisor/report", map[string]any{
		"task_id": taskID,
		"body":    "[Supervisor] " + message,
		"type":    "progress",
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Failed to post progress for task %s: %v", taskID, err))
		return
	}
	logger.Info(fmt.Sprintf("[supervisor] Progress posted for task %s", taskID))
}

// escalate is called when a task has exceeded maxSupervisorFailures consecutive
// no-verdict supervisor attempts. It posts a message to the task thread so the
// user knows manual intervention is required.
func (s *Supervisor) escalate(taskID, agentID string, attempts int) {
	if s.cfg == nil {
		return
	}
	body := fmt.Sprintf(
		"[Supervisor] Task has been stuck for %d supervision cycles (~%s) with no resolution. "+
			"Manual intervention required — check `tmux ls` or restart the agent.",
		attempts, time.Duration(attempts)*inactivityTimeout,
	)
	token, err := auth.GetToken(s.cfg.Firebase.APIKey, s.cfg.Server.URL)
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Auth failed for escalation (task %s): %v", taskID, err))
		return
	}
	_, err = api.Post(s.cfg, token, agentID, "/daemon/supervisor/report", map[string]any{
		"task_id": taskID,
		"body":    body,
		"type":    "escalation",
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Failed to post escalation for task %s: %v", taskID, err))
		return
	}
	logger.Info(fmt.Sprintf("[supervisor] Escalation posted for task %s after %d failures", taskID, attempts))
}

// logKill logs a tmux kill-session error at Debug level; nil errors are silent.
func logKill(name string, err error) {
	if err != nil {
		logger.Debug(fmt.Sprintf("[supervisor] kill-session %s: %v (may be OK if already gone)", name, err))
	}
}

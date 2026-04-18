package agent

import (
	"fmt"
	"time"

	"github.com/tasksquad/daemon/agentmode"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/tasklog"
	"github.com/tasksquad/daemon/tmux"
)

// processResponse dispatches a single heartbeat response: resolves the agent ID,
// handles control signals (reset/cancel/close/reply), and starts pending tasks.
// Called by both heartbeat() and RunBatch().
func (a *Agent) processResponse(cfg *config.Config, resp map[string]any) {
	// Resolve agentID from first heartbeat response.
	if id, ok := resp["agent_id"].(string); ok && id != "" {
		a.st.mu.Lock()
		if a.st.agentID == "" {
			a.st.agentID = id
			logger.Info(fmt.Sprintf("[%s] Resolved agent ID: %s", a.Config.Name, id))
		}
		a.st.mu.Unlock()
	}

	currentMode := a.st.ModeValue()

	// Reset requested from portal — kill tmux and go idle regardless of current mode.
	if reset, _ := resp["reset"].(bool); reset {
		logger.Info(fmt.Sprintf("[%s] Reset requested by server — killing tmux sessions and going idle", a.Config.Name))
		go a.handleReset()
		return
	}

	// When running or waiting for input: check if the server signalled a cancel, close, or learn.
	if currentMode == ModeRunning || currentMode == ModeWaitingInput {
		if cancel, _ := resp["cancel"].(bool); cancel {
			logger.Info(fmt.Sprintf("[%s] Task cancelled by server", a.Config.Name))
			go a.Complete(cfg, string(agentmode.StatusCancelled), "")
			return
		}
		if close_, _ := resp["close"].(bool); close_ {
			logger.Info(fmt.Sprintf("[%s] Session closed by server (user completed)", a.Config.Name))
			go a.closeSession(cfg)
			return
		}
		if stepsRaw, ok := resp["close_steps"]; ok && currentMode == ModeWaitingInput {
			steps := parseCloseSteps(stepsRaw)
			if len(steps) > 0 {
				logger.Info(fmt.Sprintf("[%s] Server requested close sequence (%d steps)", a.Config.Name, len(steps)))
				go a.startCloseSequence(cfg, steps)
				return
			}
		}
	}

	// When waiting for user input: check if the server has a reply ready.
	if currentMode == ModeWaitingInput {
		if reply, ok := resp["reply"].(string); ok && reply != "" {
			a.st.mu.Lock()
			sess := a.st.tmuxSession
			pw := a.st.stdinWrite
			a.st.mu.Unlock()

			if sess != "" {
				// tmux path: deliver reply via send-keys
				time.Sleep(1 * time.Second)
				tmux.SendKeys(sess, reply)        //nolint:errcheck
				a.st.Transition(EventUserReplied) //nolint:errcheck
				a.st.mu.Lock()
				a.st.lastPrompt = reply
				a.st.notifyPosted = false
				tlog := a.st.taskLog
				a.st.mu.Unlock()
				logger.Info(fmt.Sprintf("[%s] User replied — resuming via tmux", a.Config.Name))
				if tlog != nil {
					tlog.Write(tasklog.EventUserReply{Type: "user_reply", Body: reply, Ts: tasklog.Now()}) //nolint:errcheck
				}
			} else if pw != nil {
				if _, err := fmt.Fprintln(pw, reply); err != nil {
					logger.Warn(fmt.Sprintf("[%s] Failed to write reply to stdin: %v", a.Config.Name, err))
				} else {
					a.st.Transition(EventUserReplied) //nolint:errcheck
					a.st.mu.Lock()
					a.st.lastPrompt = reply
					a.st.notifyPosted = false
					tlog := a.st.taskLog
					a.st.mu.Unlock()
					logger.Info(fmt.Sprintf("[%s] User replied — resuming", a.Config.Name))
					if tlog != nil {
						tlog.Write(tasklog.EventUserReply{Type: "user_reply", Body: reply, Ts: tasklog.Now()}) //nolint:errcheck
					}
				}
			}
		}
		return // never pick up a new task while the process is still running
	}

	if task, ok := resp["task"].(map[string]any); ok && currentMode == ModeIdle {
		logger.Info(fmt.Sprintf("[%s] Task received: %s — \"%s\"", a.Config.Name, task["id"], task["subject"]))
		go a.startTask(cfg, task)
	} else {
		logger.Debug(fmt.Sprintf("[%s] No pending tasks", a.Config.Name))
	}
}

func parseCloseSteps(raw any) []string {
	arr, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

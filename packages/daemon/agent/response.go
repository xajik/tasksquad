package agent

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/tasksquad/daemon/agentmode"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/tasklog"
	"github.com/tasksquad/daemon/tmux"
)

// ansiEscape matches ANSI/VT100 escape sequences produced by terminal UIs.
var ansiEscape = regexp.MustCompile(`\x1b(\[[0-9;?]*[A-Za-z]|\][^\x07]*(\x07|\x1b\\)|\(B|[0-9A-Za-z])`)

// cleanLine strips ANSI escape sequences and handles carriage returns (\r).
// PTY output from TUI programs like Claude Code uses \r to overwrite the
// current line; we take only the segment after the last \r so the log
// contains the final visible content of each line.
func cleanLine(s string) string {
	if i := strings.LastIndex(s, "\r"); i >= 0 {
		s = s[i+1:]
	}
	return strings.TrimRight(ansiEscape.ReplaceAllString(s, ""), " \t")
}

// buildNotifyMessage extracts Claude's actual question/response from the terminal.
// The Notification hook only delivers a generic string ("Claude is waiting for
// your input"); the real question text lives in the terminal output.
//
// For the tmux path: use `tmux capture-pane` to read the current *visible*
// terminal content — far more reliable than the raw FIFO byte stream whose
// full-screen TUI redraws collapse to empty strings after ANSI cleanup.
// For the PTY path: fall back to the last 15 non-empty output lines from
// streamOutput.
func buildNotifyMessage(a *Agent, fallback string) string {
	a.st.mu.Lock()
	sess := a.st.tmuxSession
	lines := append([]string(nil), a.st.outputLines...)
	prompt := a.st.lastPrompt
	a.st.mu.Unlock()

	var visible []string

	if sess != "" && tmuxBin != "" {
		if out := tmux.CapturePane(sess, 200); out != "" {
			for _, raw := range strings.Split(out, "\n") {
				if s := strings.TrimSpace(cleanLine(raw)); s != "" {
					visible = append(visible, s)
				}
			}
		}
	} else {
		// PTY / fallback path: use the captured output lines.
		for _, raw := range lines {
			if s := strings.TrimSpace(raw); s != "" {
				visible = append(visible, s)
			}
		}
	}

	if len(visible) == 0 {
		return fallback
	}

	// Filter out lines that look like echoes of the prompt.
	var filtered []string
	cleanPrompt := strings.TrimSpace(prompt)
	for _, line := range visible {
		isPrompt := false
		if cleanPrompt != "" {
			if strings.Contains(line, cleanPrompt) || strings.Contains(cleanPrompt, line) {
				isPrompt = true
			}
		}
		if !isPrompt {
			filtered = append(filtered, line)
		}
	}

	if len(filtered) > 15 {
		filtered = filtered[len(filtered)-15:]
	}
	if len(filtered) > 0 {
		return strings.Join(filtered, "\n")
	}

	// If everything was filtered out, the agent hasn't produced anything yet
	// except echoing the prompt. Fall back to the original message.
	return fallback
}

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
		if learn, _ := resp["learn"].(bool); learn && currentMode == ModeWaitingInput {
			logger.Info(fmt.Sprintf("[%s] Server requested learning phase — injecting learning prompt", a.Config.Name))
			go a.startLearning(cfg)
			return
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

// PushIntermediateResponse posts a per-turn agent message to the task thread
// without pausing the task or changing agent mode. Called by Gemini's AfterAgent
// hook after each model turn so the portal shows progress while the session
// continues running. Task completion is signalled by SessionEnd (/hooks/stop).
func (a *Agent) PushIntermediateResponse(cfg *config.Config, promptResponse, transcriptPath string) {
	a.st.mu.Lock()
	mode := a.st.mode
	sessionID := a.st.sessionID
	a.st.mu.Unlock()

	// Post intermediate messages in both running and waiting_input modes.
	// Do NOT change the mode — a late AfterAgent hook must not resurrect a task
	// that StopAndPause has already transitioned to waiting_input (GAP-03).
	if mode != ModeRunning && mode != ModeWaitingInput {
		logger.Debug(fmt.Sprintf("[%s] PushIntermediateResponse ignored: mode=%s", a.Config.Name, mode))
		return
	}

	text := promptResponse
	if text == "" && transcriptPath != "" {
		text = a.extractTranscriptResponse(transcriptPath)
	}
	if text == "" {
		logger.Debug(fmt.Sprintf("[%s] PushIntermediateResponse: no text to post", a.Config.Name))
		return
	}

	_, err := a.post(cfg, "/daemon/session/message", map[string]any{
		"session_id": sessionID,
		"type":       "output",
		"message":    text,
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] PushIntermediateResponse error: %v", a.Config.Name, err))
	} else {
		logger.Info(fmt.Sprintf("[%s] Intermediate response posted (%d chars)", a.Config.Name, len(text)))
	}
}

// SetWaitingInput is called by the hook server on a Notification event.
// It does NOT close the session — the process keeps running so the user's
// reply can be piped back via stdin.
func (a *Agent) SetWaitingInput(cfg *config.Config, message string, transcriptPath string) {
	logger.Info(fmt.Sprintf("[%s] SetWaitingInput called — message=%q transcript_path=%q", a.Config.Name, message, transcriptPath))
	a.st.mu.Lock()
	mode := a.st.mode
	completing := a.st.completing
	agentID := a.st.agentID
	sessionID := a.st.sessionID
	a.st.mu.Unlock()

	// Ignore if not running or if complete() is already in progress.
	if mode != ModeRunning || completing {
		logger.Debug(fmt.Sprintf("[%s] SetWaitingInput ignored: mode=%s completing=%v", a.Config.Name, mode, completing))
		return
	}
	// Mark notify in progress immediately — before the 300ms sleep — so that a
	// concurrent StopAndPause goroutine sees this flag and skips its duplicate notify.
	a.st.mu.Lock()
	a.st.notifyPosted = true
	a.st.lastActivityAt = time.Now()
	a.st.mu.Unlock()

	// Wait briefly for any PTY output still buffered in the kernel.
	time.Sleep(300 * time.Millisecond)

	// Prefer transcript if available; fall back to terminal output lines.
	notifyMsg := ""
	if transcriptPath != "" {
		retryDeadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(retryDeadline) {
			notifyMsg = a.extractTranscriptResponse(transcriptPath)
			if notifyMsg != "" {
				break
			}
			time.Sleep(300 * time.Millisecond)
		}
	}
	if notifyMsg == "" {
		notifyMsg = buildNotifyMessage(a, message)
	}

	logger.Info(fmt.Sprintf("[%s] Waiting for user input: %s", a.Config.Name, notifyMsg))

	// Notify SSE clients so the portal can display the question.
	if agentID != "" {
		a.post(cfg, "/daemon/push/"+agentID, map[string]any{ //nolint:errcheck
			"type":  "waiting_input",
			"lines": []string{notifyMsg},
		})
	}

	notifyResp, err := a.post(cfg, "/daemon/session/notify", map[string]any{
		"session_id": sessionID,
		"agent_id":   agentID,
		"message":    notifyMsg,
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] Session notify error: %v", a.Config.Name, err))
	} else if notifyResp != nil {
		logger.Debug(fmt.Sprintf("[%s] Session notify response: %v", a.Config.Name, notifyResp))
		msgID, _ := notifyResp["message_id"].(string)
		if msgID != "" && transcriptPath != "" {
			go a.uploadAndAttach(cfg, sessionID, msgID, "notif-"+msgID+".jsonl", transcriptPath)
		}
	}

	if err := a.st.Transition(EventHookNotification); err != nil {
		logger.Warn(fmt.Sprintf("[%s] SetWaitingInput: unexpected transition error: %v", a.Config.Name, err))
	}

	a.st.mu.Lock()
	tlog := a.st.taskLog
	a.st.mu.Unlock()
	if tlog != nil {
		tlog.Write(tasklog.EventAgentTurn{ //nolint:errcheck
			Type:           "agent_turn",
			Body:           notifyMsg,
			TranscriptPath: transcriptPath,
			Ts:             tasklog.Now(),
		})
	}
}

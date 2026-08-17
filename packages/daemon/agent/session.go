package agent

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/tasksquad/daemon/agentmode"
	"github.com/tasksquad/daemon/analytics"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/tasklog"
	"github.com/tasksquad/daemon/tmux"
)

// Complete is called by the hook server when the provider emits a Stop event.
// For the tmux path it kills the tmux session (which closes the FIFO writer,
// draining the last output) and then calls complete() with the hook-supplied
// status. For the PTY path it closes stdin and lets cmd.Wait() in startTask
// determine the exit code and call complete() from there.
func (a *Agent) Complete(cfg *config.Config, status string, transcriptPath string) {
	a.st.mu.Lock()
	if a.st.completing || a.st.sessionID == "" {
		a.st.mu.Unlock()
		return
	}
	a.st.completing = true
	wasLearning := a.st.mode == ModeLearning
	sessionID := a.st.sessionID
	agentID := a.st.agentID
	taskID := a.st.taskID
	pw := a.st.stdinWrite
	a.st.stdinWrite = nil
	runLog := a.st.runLog
	a.st.runLog = nil
	outputDone := a.st.outputDone
	sess := a.st.tmuxSession
	fifo := a.st.fifoPath
	if transcriptPath == "" {
		transcriptPath = a.st.transcriptPath
	}
	a.st.tmuxSession = ""
	a.st.fifoPath = ""
	a.st.transcriptPath = ""
	a.st.mu.Unlock()

	go a.internalComplete(cfg, status, sessionID, agentID, taskID, pw, runLog, outputDone, sess, fifo, transcriptPath, wasLearning)
}

// StopAndPause is called by the hook server when Claude Code's Stop hook fires
// and the stop_reason is not "error". Instead of killing the tmux session and
// closing the task, it posts the final response as an agent message and moves
// to waiting_input — keeping the tmux session alive so the user can send a
// follow-up or click "Complete session" to cleanly shut down.
func (a *Agent) StopAndPause(cfg *config.Config, hookMessage, transcriptPath string) {
	a.st.mu.Lock()
	mode := a.st.mode
	completing := a.st.completing
	notifyPosted := a.st.notifyPosted
	sessionID := a.st.sessionID
	agentID := a.st.agentID
	sess := a.st.tmuxSession
	a.st.mu.Unlock()

	if mode != ModeRunning || completing {
		logger.Debug(fmt.Sprintf("[%s] StopAndPause ignored: mode=%s completing=%v", a.Config.Name, mode, completing))
		return
	}

	// SetWaitingInput already posted a notify for this turn (Claude Code fires
	// Notification then Stop for question turns). Save the updated transcriptPath
	// (Claude may have finished writing it by now) and return without a second notify.
	if notifyPosted {
		if transcriptPath != "" {
			a.st.mu.Lock()
			a.st.transcriptPath = transcriptPath
			a.st.mu.Unlock()
		}
		logger.Debug(fmt.Sprintf("[%s] StopAndPause: skipping duplicate notify (Notification hook already posted)", a.Config.Name))
		return
	}

	// Wait briefly for FIFO output to drain.
	time.Sleep(300 * time.Millisecond)

	tmuxCapture, tmuxCapturePath := a.captureTerminalState(sess)
	a.st.mu.Lock()
	a.st.lastTmuxCapturePath = tmuxCapturePath
	a.st.mu.Unlock()

	// Extract final response text.
	// Priority: hookMessage → transcript → tmux scrollback → outputLines.
	finalText := hookMessage
	if finalText == "" && transcriptPath != "" {
		retryDeadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(retryDeadline) {
			finalText = a.extractTranscriptResponse(transcriptPath)
			if finalText != "" {
				logger.Info(fmt.Sprintf("[%s] Final text from transcript (%d chars)", a.Config.Name, len(finalText)))
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
	}
	if finalText == "" && tmuxCapture != "" {
		finalText = tmuxCapture
		if len(finalText) > 10000 {
			finalText = finalText[len(finalText)-10000:]
		}
	}
	if finalText == "" {
		a.st.mu.Lock()
		lines := append([]string(nil), a.st.outputLines...)
		a.st.mu.Unlock()
		finalText = strings.TrimSpace(strings.Join(lines, "\n"))
		if len(finalText) > 10000 {
			finalText = finalText[len(finalText)-10000:]
		}
	}

	notifyResp, err := a.post(cfg, "/daemon/session/notify", map[string]any{
		"session_id": sessionID,
		"agent_id":   agentID,
		"message":    finalText,
	})

	autoClose := false
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] StopAndPause notify error: %v", a.Config.Name, err))
	} else if notifyResp != nil {
		autoClose, _ = notifyResp["close"].(bool)
		msgID, _ := notifyResp["message_id"].(string)
		if msgID != "" {
			// Prioritize transcript.jsonl (rich JSONL data), fallback to transcript.txt (plain tmux capture)
			if transcriptPath != "" {
				go a.uploadAndAttach(cfg, sessionID, msgID, "transcript.jsonl", transcriptPath)
			} else if tmuxCapture != "" {
				go a.uploadAndAttachContent(cfg, sessionID, msgID, "transcript.txt", []byte(tmuxCapture))
			}
		}
	}

	a.st.mu.Lock()
	lines := append([]string(nil), a.st.outputLines...)
	a.st.mu.Unlock()
	logContent := strings.Join(lines, "\n")
	if tmuxCapture != "" {
		logContent = tmuxCapture
	}
	go a.uploadAndAttachLog(cfg, sessionID, logContent)

	if autoClose {
		a.autoCloseAndReset()
		return
	}

	a.st.mu.Lock()
	if transcriptPath != "" {
		a.st.transcriptPath = transcriptPath
	}
	a.st.mu.Unlock()
	if err := a.st.Transition(EventHookStop); err != nil {
		logger.Warn(fmt.Sprintf("[%s] StopAndPause: unexpected transition error: %v", a.Config.Name, err))
	}

	logger.Info(fmt.Sprintf("[%s] Paused after response — tmux session kept alive, waiting for reply or close", a.Config.Name))
}

// autoCloseAndReset cleans up all task-scoped resources and resets the agent to
// idle when the server responds with close:true. Must NOT be called with a.st.mu held.
func (a *Agent) autoCloseAndReset() {
	a.st.mu.Lock()
	fifo := a.st.fifoPath
	runLog := a.st.runLog
	pw := a.st.stdinWrite
	sess := a.st.tmuxSession
	a.st.tmuxSession = ""
	a.st.fifoPath = ""
	a.st.sessionID = ""
	a.st.taskID = ""
	a.st.transcriptPath = ""
	a.st.lastTmuxCapturePath = ""
	a.st.cliSessionID = ""
	a.st.tuiBlocked = false
	a.st.stdinWrite = nil
	a.st.runLog = nil
	a.st.mode = ModeIdle
	a.st.outputLines = nil
	a.st.completing = false
	a.st.notifyPosted = false
	a.st.mu.Unlock()
	if sess != "" {
		exec.Command(tmuxBin, "kill-session", "-t", sess).Run() //nolint:errcheck
	} else if pw != nil {
		pw.Close()
	}
	if fifo != "" {
		os.Remove(fifo) //nolint:errcheck
	}
	if runLog != nil {
		fmt.Fprintf(runLog, "\n[EVENT] event=success\n# ended=%s\n", time.Now().Format(time.RFC3339))
		runLog.Close()
	}
	logger.Info(fmt.Sprintf("[%s] Auto-close: agent reset to idle", a.Config.Name))
}

// handleReset kills any running tmux session and returns the agent to idle.
func (a *Agent) handleReset() {
	a.st.mu.Lock()
	sess := a.st.tmuxSession
	fifo := a.st.fifoPath
	pw := a.st.stdinWrite
	a.st.stdinWrite = nil
	a.st.tmuxSession = ""
	a.st.fifoPath = ""
	a.st.transcriptPath = ""
	a.st.lastTmuxCapturePath = ""
	a.st.sessionID = ""
	a.st.taskID = ""
	a.st.cliSessionID = ""
	a.st.tuiBlocked = false
	a.st.completing = false
	a.st.mode = ModeIdle
	a.st.mu.Unlock()

	if sess != "" && tmuxBin != "" {
		exec.Command(tmuxBin, "kill-session", "-t", sess).Run() //nolint:errcheck
		logger.Info(fmt.Sprintf("[%s] Reset: killed tmux session %s", a.Config.Name, sess))
	} else if pw != nil {
		pw.Close()
	}
	if fifo != "" {
		os.Remove(fifo) //nolint:errcheck
	}

	logger.Info(fmt.Sprintf("[%s] Reset complete — idle, ready to pull new tasks on next heartbeat", a.Config.Name))
}

// closeSession is called by heartbeat when the server sends a "close" signal,
// meaning the user clicked "Complete session" in the portal. It kills the tmux
// session and resets the agent to idle WITHOUT calling /daemon/session/close
// (the server already closed the session and task).
func (a *Agent) closeSession(cfg *config.Config) {
	a.st.mu.Lock()
	sess := a.st.tmuxSession
	fifo := a.st.fifoPath
	runLog := a.st.runLog
	a.st.tmuxSession = ""
	a.st.fifoPath = ""
	a.st.sessionID = ""
	a.st.transcriptPath = ""
	a.st.lastTmuxCapturePath = ""
	a.st.tuiBlocked = false
	a.st.mode = ModeIdle
	a.st.outputLines = nil
	a.st.runLog = nil
	a.st.mu.Unlock()

	if runLog != nil {
		fmt.Fprintf(runLog, "\n[EVENT] event=closed_by_user\n# ended=%s\n", time.Now().Format(time.RFC3339))
		runLog.Close()
	}
	if sess != "" {
		exec.Command(tmuxBin, "kill-session", "-t", sess).Run() //nolint:errcheck
	}
	if fifo != "" {
		os.Remove(fifo)
	}
	logger.Info(fmt.Sprintf("[%s] Session closed by user — tmux killed, agent reset to idle", a.Config.Name))
}

// PushIntermediateResponse posts a per-turn agent message to the task thread
// without pausing the task or changing agent mode. Called by Gemini's AfterAgent
// hook after each model turn so the portal shows progress while the session
// continues running. If the server responds with close:true the session is
// auto-closed immediately (same as StopAndPause auto-close path).
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

	resp, err := a.post(cfg, "/daemon/session/message", map[string]any{
		"session_id": sessionID,
		"type":       "output",
		"message":    text,
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] PushIntermediateResponse error: %v", a.Config.Name, err))
		return
	}
	logger.Info(fmt.Sprintf("[%s] Intermediate response posted (%d chars)", a.Config.Name, len(text)))
	analytics.Track("task_intermediate_response", map[string]interface{}{
		"task_id":    a.st.TaskID(),
		"agent_name": a.Config.Name,
	})

	if autoClose, _ := resp["close"].(bool); autoClose {
		a.autoCloseAndReset()
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
	analytics.Track("task_waiting_for_input", map[string]interface{}{
		"task_id":    a.st.TaskID(),
		"agent_name": a.Config.Name,
	})

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

// startCloseSequence transitions the agent to ModeLearning and begins executing
// the provided steps sequentially via tmux. Each step is sent as-is to the active
// tmux session; the next step starts only after the Stop hook fires (CLI finished
// the previous step). When all steps are done, Complete is called.
func (a *Agent) startCloseSequence(cfg *config.Config, steps []string) {
	if err := a.st.Transition(EventLearnStart); err != nil {
		logger.Warn(fmt.Sprintf("[%s] startCloseSequence: unexpected transition error: %v", a.Config.Name, err))
		return
	}

	a.st.mu.Lock()
	a.st.pendingSteps = append([]string{}, steps...)
	a.st.executedSteps = nil
	sess := a.st.tmuxSession
	taskID := a.st.taskID
	a.st.mu.Unlock()

	analytics.Track("task_close_sequence_started", map[string]interface{}{
		"task_id":    taskID,
		"agent_name": a.Config.Name,
		"step_count": len(steps),
	})

	if sess == "" || tmuxBin == "" {
		logger.Warn(fmt.Sprintf("[%s] startCloseSequence: no tmux session — completing task directly", a.Config.Name))
		go a.Complete(cfg, string(agentmode.StatusClosed), "")
		return
	}

	a.injectNextStep(sess)
}

// advanceCloseStep is called by the Stop hook when the agent is in ModeLearning.
// It marks the current step as executed, injects the next one, or calls Complete
// when the queue is empty.
func (a *Agent) advanceCloseStep(cfg *config.Config) {
	a.st.mu.Lock()
	if len(a.st.pendingSteps) > 0 {
		done := a.st.pendingSteps[0]
		a.st.executedSteps = append(a.st.executedSteps, done)
		a.st.pendingSteps = a.st.pendingSteps[1:]
	}
	remaining := len(a.st.pendingSteps)
	sess := a.st.tmuxSession
	a.st.mu.Unlock()

	if remaining > 0 {
		a.injectNextStep(sess)
		return
	}
	a.Complete(cfg, string(agentmode.StatusClosed), "")
}

// injectNextStep sends the first pending step as-is into the tmux session.
func (a *Agent) injectNextStep(sess string) {
	a.st.mu.Lock()
	if len(a.st.pendingSteps) == 0 {
		a.st.mu.Unlock()
		return
	}
	step := a.st.pendingSteps[0]
	total := len(a.st.pendingSteps) + len(a.st.executedSteps)
	idx := len(a.st.executedSteps) + 1
	a.st.mu.Unlock()

	logger.Info(fmt.Sprintf("[%s] Close step %d/%d: %q", a.Config.Name, idx, total, step))
	time.Sleep(500 * time.Millisecond)
	tmux.SendKeys(sess, step) //nolint:errcheck
}

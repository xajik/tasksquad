package agent

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/tasksquad/daemon/agentmode"
	"github.com/tasksquad/daemon/analytics"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/tasklog"
)

// complete finalises the current task. Safe to call from both the hook handler
// and the process-exit path — the completing flag prevents double execution.
func (a *Agent) complete(cfg *config.Config, status string) {
	a.st.mu.Lock()
	if a.st.completing || a.st.sessionID == "" {
		a.st.mu.Unlock()
		return
	}
	a.st.completing = true
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
	transcriptPath := a.st.transcriptPath
	a.st.tmuxSession = ""
	a.st.fifoPath = ""
	a.st.transcriptPath = ""
	a.st.mu.Unlock()

	a.internalComplete(cfg, status, sessionID, agentID, taskID, pw, runLog, outputDone, sess, fifo, transcriptPath, false)
}

const tmuxCaptureFallbackFile = ".tasksquad-tmux-capture.txt"

func (a *Agent) captureTerminalState(sess string) (content string, path string) {
	if sess == "" || tmuxBin == "" {
		return "", ""
	}
	out, err := exec.Command(tmuxBin, "capture-pane", "-t", sess, "-p", "-S", "-").Output()
	if err == nil {
		result := strings.TrimSpace(string(out))
		logger.Info(fmt.Sprintf("[%s] Captured %d chars from tmux scrollback", a.Config.Name, len(result)))

		fallbackPath := filepath.Join(a.Config.WorkDir, tmuxCaptureFallbackFile)
		if writeErr := os.WriteFile(fallbackPath, []byte(result), 0644); writeErr == nil {
			logger.Debug(fmt.Sprintf("[%s] Wrote tmux capture to %s", a.Config.Name, fallbackPath))
			return result, fallbackPath
		} else {
			logger.Warn(fmt.Sprintf("[%s] Failed to write tmux capture file: %v", a.Config.Name, writeErr))
		}
		return result, ""
	}
	logger.Warn(fmt.Sprintf("[%s] tmux capture-pane failed: %v", a.Config.Name, err))
	return "", ""
}

func (a *Agent) closeProcessResources(sess, fifo string, pw io.WriteCloser, outputDone chan struct{}) {
	if sess != "" {
		exec.Command(tmuxBin, "kill-session", "-t", sess).Run()
	} else if pw != nil {
		pw.Close()
	}

	if outputDone != nil {
		select {
		case <-outputDone:
		case <-time.After(15 * time.Second):
			logger.Warn(fmt.Sprintf("[%s] Timed out waiting for stdout drain", a.Config.Name))
		}
	}

	if fifo != "" {
		os.Remove(fifo)
	}
}

func (a *Agent) emitLifecycleEvent(status, taskID string, runLog *os.File, tmuxCapture string) {
	if status == string(agentmode.StatusClosed) {
		logger.Lifecycle(fmt.Sprintf("[%s] event=success task_id=%s", a.Config.Name, taskID))
		if runLog != nil {
			fmt.Fprintf(runLog, "\n[EVENT] event=success\n# ended=%s\n", time.Now().Format(time.RFC3339))
		}
	} else {
		logger.Lifecycle(fmt.Sprintf("[%s] event=failure task_id=%s status=%s", a.Config.Name, taskID, status))
		if runLog != nil {
			fmt.Fprintf(runLog, "\n[EVENT] event=failure status=%s\n# ended=%s\n", status, time.Now().Format(time.RFC3339))
		}
	}
	if runLog != nil && tmuxCapture != "" {
		fmt.Fprintf(runLog, "\n# --- terminal scrollback ---\n%s\n", tmuxCapture)
	}
	if runLog != nil {
		runLog.Close()
	}
}

func (a *Agent) postSessionClose(cfg *config.Config, sessionID, agentID, status, finalText string) map[string]any {
	resp, err := a.post(cfg, "/daemon/session/close", map[string]any{
		"session_id": sessionID,
		"agent_id":   agentID,
		"status":     status,
		"final_text": finalText,
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] Session close error: %v", a.Config.Name, err))
		return nil
	}
	logger.Debug(fmt.Sprintf("[%s] Session close response: %v", a.Config.Name, resp))
	return resp
}

func (a *Agent) uploadTaskArtifacts(cfg *config.Config, sessionID, msgID, logContent, tmuxCapture, transcriptPath string) {
	go a.uploadAndAttachLog(cfg, sessionID, logContent)

	if msgID != "" {
		// Prioritize transcript.jsonl (rich JSONL data), fallback to transcript.txt (plain tmux capture)
		if transcriptPath != "" {
			go a.uploadAndAttach(cfg, sessionID, msgID, "transcript.jsonl", transcriptPath)
		} else if tmuxCapture != "" {
			go a.uploadAndAttachContent(cfg, sessionID, msgID, "transcript.txt", []byte(tmuxCapture))
		}
	}
}


func (a *Agent) internalComplete(cfg *config.Config, status, sessionID, agentID, taskID string, pw io.WriteCloser, runLog *os.File, outputDone chan struct{}, sess, fifo, transcriptPath string, wasLearning bool) {
	logger.Info(fmt.Sprintf("[%s] internalComplete called — status=%q taskID=%s transcriptPath=%q", a.Config.Name, status, taskID, transcriptPath))
	if status == "" {
		status = string(agentmode.StatusClosed)
	}

	a.st.mu.Lock()
	startedAt := a.st.startedAt
	a.st.mu.Unlock()

	tmuxCapture, tmuxCapturePath := a.captureTerminalState(sess)

	// Store tmux capture path in state for potential stale hook fallback
	a.st.mu.Lock()
	a.st.lastTmuxCapturePath = tmuxCapturePath
	a.st.mu.Unlock()

	a.closeProcessResources(sess, fifo, pw, outputDone)

	a.st.mu.Lock()
	lines := append([]string(nil), a.st.outputLines...)
	a.st.mu.Unlock()

	logger.Info(fmt.Sprintf("[%s] Completing task %s — status=%s", a.Config.Name, taskID, status))

	a.emitLifecycleEvent(status, taskID, runLog, tmuxCapture)

	durationSecs := 0.0
	if !startedAt.IsZero() {
		durationSecs = time.Since(startedAt).Seconds()
	}
	switch status {
	case string(agentmode.StatusClosed):
		analytics.Track("task_completed", map[string]interface{}{
			"task_id":       taskID,
			"agent_name":    a.Config.Name,
			"provider":      a.Provider(),
			"duration_secs": durationSecs,
		})
	case string(agentmode.StatusCrashed):
		analytics.Track("task_failed", map[string]interface{}{
			"task_id":       taskID,
			"agent_name":    a.Config.Name,
			"provider":      a.Provider(),
			"duration_secs": durationSecs,
		})
	case string(agentmode.StatusCancelled):
		analytics.Track("task_cancelled", map[string]interface{}{
			"task_id":       taskID,
			"agent_name":    a.Config.Name,
			"duration_secs": durationSecs,
		})
	}

	a.st.mu.Lock()
	hookMsg := a.st.hookMessage
	a.st.hookMessage = ""
	a.st.mu.Unlock()

	finalText := a.extractFinalText(hookMsg, transcriptPath, tmuxCapture, lines, wasLearning)

	closeResp := a.postSessionClose(cfg, sessionID, agentID, status, finalText)

	msgID := ""
	if closeResp != nil {
		msgID, _ = closeResp["message_id"].(string)
	}

	logContent := strings.Join(lines, "\n")
	if tmuxCapture != "" {
		logContent = tmuxCapture
	}
	a.uploadTaskArtifacts(cfg, sessionID, msgID, logContent, tmuxCapture, transcriptPath)

	a.st.mu.Lock()
	tlog := a.st.taskLog
	a.st.taskLog = nil
	a.st.mu.Unlock()
	if tlog != nil {
		r2LogKey := ""
		if closeResp != nil {
			r2LogKey, _ = closeResp["r2_log_key"].(string)
		}
		tlog.Write(tasklog.EventTaskEnd{ //nolint:errcheck
			Type:      "task_end",
			Status:    status,
			FinalText: finalText,
			R2LogKey:  r2LogKey,
			Ts:        tasklog.Now(),
		})
		tlog.Close()
	}

	a.st.mu.Lock()
	a.st.mode = ModeIdle
	a.st.sessionID = ""
	a.st.outputLines = nil
	a.st.outputDone = nil
	a.st.proc = nil
	a.st.completing = false
	a.st.mu.Unlock()
}

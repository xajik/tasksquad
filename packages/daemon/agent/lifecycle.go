package agent

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/tasksquad/daemon/agentmode"
	"github.com/tasksquad/daemon/analytics"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/tasklog"
	"github.com/tasksquad/daemon/tmux"
)

// buildConversationPrompt constructs the prompt to send to the CLI provider.
// For a fresh task (single message), it uses that message directly.
// For a follow-up (multiple messages), it formats the full thread as a
// Human/Assistant conversation so the model has prior context.
//
// memoryRollup, when non-empty, is the team's recent-activity summary
// (server-computed from global-scope memory; see the agentic memory spec)
// and is prepended as a clearly-delimited section ahead of the usual
// subject/thread content. An empty memoryRollup leaves the prompt exactly as
// it was before this parameter existed.
func buildConversationPrompt(subject string, rawMsgs any, memoryRollup string) string {
	base := buildBasePrompt(subject, rawMsgs)
	if memoryRollup == "" {
		return base
	}
	return fmt.Sprintf("## Project memory (recent activity)\n%s\n\n---\n\n%s", memoryRollup, base)
}

func buildBasePrompt(subject string, rawMsgs any) string {
	msgs, _ := rawMsgs.([]interface{})
	if len(msgs) == 0 {
		return subject
	}
	if len(msgs) == 1 {
		m, _ := msgs[0].(map[string]interface{})
		if body, _ := m["body"].(string); body != "" {
			return body
		}
		return subject
	}
	// Multi-turn: format as Human/Assistant turns
	var sb strings.Builder
	for _, raw := range msgs {
		m, _ := raw.(map[string]interface{})
		role, _ := m["role"].(string)
		body, _ := m["body"].(string)
		switch role {
		case "user":
			sb.WriteString("Human: ")
			sb.WriteString(body)
			sb.WriteString("\n\n")
		case "agent":
			sb.WriteString("Assistant: ")
			sb.WriteString(body)
			sb.WriteString("\n\n")
		}
	}
	return strings.TrimSpace(sb.String())
}

func (a *Agent) startTask(cfg *config.Config, task map[string]any, memoryRollup string) {
	taskID, _ := task["id"].(string)
	subject, _ := task["subject"].(string)

	if err := a.st.Transition(EventTaskStarted); err != nil {
		logger.Warn(fmt.Sprintf("[%s] startTask: unexpected transition error: %v", a.Config.Name, err))
	}
	now := time.Now()
	a.st.mu.Lock()
	a.st.taskID = taskID
	a.st.startedAt = now
	a.st.pendingSteps = nil
	a.st.executedSteps = nil
	a.st.outputLines = nil
	a.st.completing = false
	a.st.notifyPosted = false
	a.st.hookMessage = ""
	a.st.lastActivityAt = now
	a.st.transcriptPath = ""
	a.st.lastTmuxCapturePath = ""
	a.st.mu.Unlock()

	logger.Lifecycle(fmt.Sprintf("[%s] event=started task_id=%s subject=%q", a.Config.Name, taskID, subject))
	logger.Info(fmt.Sprintf("[%s] Starting task %s: \"%s\"", a.Config.Name, taskID, subject))

	// Open a per-task log file for the full run output.
	runLog, err := logger.CreateRunLog(a.Config.Name, taskID)
	if err != nil {
		logger.Warn(fmt.Sprintf("[%s] Could not create run log: %v", a.Config.Name, err))
	} else {
		fmt.Fprintf(runLog, "# TaskSquad run log\n# agent=%s  task_id=%s  subject=%s\n# started=%s\n\n",
			a.Config.Name, taskID, subject, time.Now().Format(time.RFC3339))
		a.st.mu.Lock()
		a.st.runLog = runLog
		a.st.lastLogPath = runLog.Name()
		a.st.mu.Unlock()
	}

	// Open session on the server.
	sessResp, err := a.post(cfg, "/daemon/session/open", map[string]any{
		"task_id": taskID,
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] Session open failed: %v", a.Config.Name, err))
		analytics.Track("task_spawn_failed", map[string]interface{}{
			"task_id":    taskID,
			"agent_name": a.Config.Name,
			"error":      "session_open_failed",
		})
		a.st.Transition(EventSpawnFailed) //nolint:errcheck
		return
	}

	sessionID, _ := sessResp["session_id"].(string)
	a.st.mu.Lock()
	a.st.sessionID = sessionID
	a.st.mu.Unlock()

	// Dial the terminal relay DO so raw PTY bytes stream to the portal in real-time.
	if token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL); err == nil {
		a.st.mu.Lock()
		agentID := a.st.agentID
		a.st.mu.Unlock()
		a.relayConn = dialTerminalRelay(cfg, token, agentID, sessionID)
	}

	// Open per-task JSONL record.
	tlog, tlErr := tasklog.Open(taskID)
	if tlErr != nil {
		logger.Warn(fmt.Sprintf("[%s] Could not open task log: %v", a.Config.Name, tlErr))
	} else {
		a.st.mu.Lock()
		a.st.taskLog = tlog
		logPath := a.st.lastLogPath
		agentID := a.st.agentID
		a.st.mu.Unlock()
		tlog.Write(tasklog.EventTaskStart{ //nolint:errcheck
			Type:      "task_start",
			TaskID:    taskID,
			Agent:     a.Config.Name,
			AgentID:   agentID,
			SessionID: sessionID,
			Subject:   subject,
			LogPath:   logPath,
			Ts:        tasklog.Now(),
		})
		if msgs, ok := task["messages"].([]interface{}); ok {
			for _, raw := range msgs {
				m, _ := raw.(map[string]interface{})
				role, _ := m["role"].(string)
				body, _ := m["body"].(string)
				tlog.Write(tasklog.EventMessage{ //nolint:errcheck
					Type: "message",
					Role: role,
					Body: body,
					Ts:   tasklog.Now(),
				})
			}
		}
	}

	// Let the provider write any hook/config files it needs.
	if err := a.prov.Setup(a.Config.WorkDir, cfg.Hooks.Port, a.Config.ID, taskID); err != nil {
		logger.Warn(fmt.Sprintf("[%s] Provider setup warning: %v", a.Config.Name, err))
	}

	// Build prompt from the full conversation history.
	prompt := buildConversationPrompt(subject, task["messages"], memoryRollup)
	a.st.mu.Lock()
	a.st.lastPrompt = prompt
	a.st.mu.Unlock()

	// Spawn the command.
	parts := strings.Fields(a.Config.Command)
	extraArgs := a.prov.ExtraArgs()
	stdinData := a.prov.Stdin(prompt)
	var args []string
	if stdinData != "" {
		args = append(parts[1:], extraArgs...)
	} else {
		args = append(append(parts[1:], extraArgs...), "-p", prompt)
	}
	cmd := exec.Command(parts[0], args...)
	cmd.Dir = a.Config.WorkDir

	provEnv := a.prov.Env(cfg.Hooks.Port)
	if len(provEnv) > 0 {
		cmd.Env = append(os.Environ(), provEnv...)
	} else {
		cmd.Env = os.Environ()
	}

	outputDone := make(chan struct{})
	a.st.mu.Lock()
	a.st.outputDone = outputDone
	a.st.mu.Unlock()

	var outputReader io.Reader
	usingTmux := false

	// ── tmux path (required for stdin-based providers) ────────────────────────
	if stdinData != "" {
		if tmuxBin == "" {
			logger.Error(fmt.Sprintf("[%s] tmux is required but not found — cannot start task", a.Config.Name))
			a.complete(cfg, string(agentmode.StatusCrashed))
			close(outputDone)
			return
		}

		sessionName := fmt.Sprintf("tsq-%s", sessionID)
		fifoPath := fmt.Sprintf("/tmp/tsq-%s.fifo", sessionID)
		os.Remove(fifoPath)

		if err := mkfifo(fifoPath, 0644); err != nil {
			logger.Error(fmt.Sprintf("[%s] mkfifo failed: %v — cannot start task", a.Config.Name, err))
			a.complete(cfg, string(agentmode.StatusCrashed))
			close(outputDone)
			return
		}

		cmdParts := append([]string{parts[0]}, args...)
		newSessionArgs := append([]string{"new-session", "-d", "-s", sessionName,
			"-c", a.Config.WorkDir, "--"}, cmdParts...)
		tmuxCmd := exec.Command(tmuxBin, newSessionArgs...)
		if len(provEnv) > 0 {
			tmuxCmd.Env = append(os.Environ(), provEnv...)
		} else {
			tmuxCmd.Env = os.Environ()
		}
		var tmuxStderr bytes.Buffer
		tmuxCmd.Stderr = &tmuxStderr

		if err := tmuxCmd.Run(); err != nil {
			logger.Error(fmt.Sprintf("[%s] tmux new-session failed: %v stderr=%q — cannot start task", a.Config.Name, err, tmuxStderr.String()))
			os.Remove(fifoPath)
			a.complete(cfg, string(agentmode.StatusCrashed))
			close(outputDone)
			return
		}

		fifoCh := make(chan *os.File, 1)
		go func() {
			f, err := os.Open(fifoPath)
			if err != nil {
				return
			}
			fifoCh <- f
		}()

		exec.Command(tmuxBin, "pipe-pane", "-t", sessionName, "cat > "+fifoPath).Run() //nolint:errcheck

		tmux.WaitForReady()
		tmux.SendKeys(sessionName, stdinData) //nolint:errcheck

		a.st.mu.Lock()
		a.st.tmuxSession = sessionName
		a.st.fifoPath = fifoPath
		a.st.mu.Unlock()

		logger.Info(fmt.Sprintf("[%s] tmux session started — attach: tmux attach-session -t %s", a.Config.Name, sessionName))

		select {
		case f := <-fifoCh:
			outputReader = f
			usingTmux = true
		case <-time.After(5 * time.Second):
			logger.Error(fmt.Sprintf("[%s] FIFO open timed out — cannot start task", a.Config.Name))
			exec.Command(tmuxBin, "kill-session", "-t", sessionName).Run() //nolint:errcheck
			os.Remove(fifoPath)
			a.st.mu.Lock()
			a.st.tmuxSession = ""
			a.st.fifoPath = ""
			a.st.mu.Unlock()
			a.complete(cfg, string(agentmode.StatusCrashed))
			close(outputDone)
			return
		}
	} else {
		// Non-stdin providers (e.g. codex): use regular stdout pipe with -p flag.
		stdout, serr := cmd.StdoutPipe()
		if serr != nil {
			logger.Error(fmt.Sprintf("[%s] StdoutPipe error: %v", a.Config.Name, serr))
			a.st.mu.Lock()
			a.st.mode = ModeIdle
			a.st.mu.Unlock()
			close(outputDone)
			return
		}
		stderr, _ := cmd.StderrPipe()
		if serr = cmd.Start(); serr != nil {
			logger.Error(fmt.Sprintf("[%s] Spawn failed: %v", a.Config.Name, serr))
			a.st.mu.Lock()
			a.st.mode = ModeIdle
			a.st.mu.Unlock()
			close(outputDone)
			return
		}
		go io.Copy(io.Discard, stderr)
		outputReader = stdout
	}

	a.st.mu.Lock()
	if !usingTmux {
		a.st.proc = cmd
	}
	agentID := a.st.agentID
	a.st.mu.Unlock()

	via := "pipe"
	if usingTmux {
		via = "tmux"
		sessionSuffix := sessionID
		if len(sessionSuffix) > 8 {
			sessionSuffix = sessionSuffix[:8]
		}
		logger.Lifecycle(fmt.Sprintf("[%s] event=running task_id=%s via=tmux session=tsq-%s", a.Config.Name, taskID, sessionSuffix))
		a.writeRunLog("[EVENT] event=running via=tmux")
	} else {
		logger.Lifecycle(fmt.Sprintf("[%s] event=running task_id=%s via=pipe pid=%d", a.Config.Name, taskID, cmd.Process.Pid))
		a.writeRunLog(fmt.Sprintf("[EVENT] event=running via=pipe pid=%d", cmd.Process.Pid))
	}
	analytics.Track("task_started", map[string]interface{}{
		"task_id":    taskID,
		"agent_name": a.Config.Name,
		"provider":   a.Provider(),
		"via":        via,
	})

	go func() {
		a.streamOutput(cfg, agentID, outputReader)
		close(outputDone)
	}()

	if usingTmux {
		<-outputDone
		if a.prov.UsesHooks() {
			a.complete(cfg, string(agentmode.StatusCrashed))
		} else {
			a.complete(cfg, "")
		}
		return
	}

	// ── PTY / pipe path: wait for process exit ────────────────────────────────
	code := 0
	if err := cmd.Wait(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		}
	}

	a.st.mu.Lock()
	if pw := a.st.stdinWrite; pw != nil {
		pw.Close()
		a.st.stdinWrite = nil
	}
	a.st.mu.Unlock()

	logger.Info(fmt.Sprintf("[%s] Process exited (code %d)", a.Config.Name, code))
	logger.Lifecycle(fmt.Sprintf("[%s] event=exit code=%d task_id=%s", a.Config.Name, code, taskID))
	a.writeRunLog(fmt.Sprintf("[EVENT] event=exit code=%d", code))

	status := string(agentmode.StatusClosed)
	if code != 0 {
		status = string(agentmode.StatusCrashed)
	}
	a.complete(cfg, status)
}

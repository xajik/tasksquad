package agent

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/provider"
)

type Mode string

const (
	ModeIdle         Mode = "idle"
	ModeRunning      Mode = "running"
	ModeWaitingInput Mode = "waiting_input"
)

type Agent struct {
	Config config.AgentConfig
	prov   provider.Provider

	mu          sync.Mutex
	mode        Mode
	agentID     string // resolved from server on first heartbeat
	sessionID   string
	taskID      string
	outputLines []string
	completing  bool
	proc        *exec.Cmd
	stdinWrite  *io.PipeWriter // open while process is running (stdin-based providers only)
	runLog      *os.File       // per-task log file, open while task runs
	outputDone  chan struct{}   // closed when streamOutput finishes draining stdout
}

func New(cfg config.AgentConfig) *Agent {
	return &Agent{
		Config: cfg,
		mode:   ModeIdle,
		prov:   provider.Detect(cfg.Command, cfg.Provider),
	}
}

// Name implements the ui.AgentStatus interface.
func (a *Agent) Name() string { return a.Config.Name }

// GetMode implements the hooks.Agent and ui.AgentStatus interfaces.
func (a *Agent) GetMode() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return string(a.mode)
}

// Run is the main poll loop for this agent.
func (a *Agent) Run(cfg *config.Config) {
	logger.Info(fmt.Sprintf("[%s] Starting — provider: %s, command: %s", a.Config.Name, a.prov.Name(), a.Config.Command))

	ticker := time.NewTicker(time.Duration(cfg.Server.PollInterval) * time.Second)
	defer ticker.Stop()

	// run one heartbeat immediately on start
	a.heartbeat(cfg)

	for range ticker.C {
		a.heartbeat(cfg)
	}
}

func (a *Agent) post(cfg *config.Config, path string, body any) (map[string]any, error) {
	return api.Post(cfg, a.Config.Token, path, body)
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

func (a *Agent) heartbeat(cfg *config.Config) {
	a.mu.Lock()
	mode := a.mode
	a.mu.Unlock()

	logger.Debug(fmt.Sprintf("[%s] Heartbeat → status=%s", a.Config.Name, mode))

	resp, err := a.post(cfg, "/daemon/heartbeat", map[string]any{
		"status": string(mode),
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] Heartbeat failed: %v", a.Config.Name, err))
		return
	}

	// Resolve agentID from first heartbeat response.
	if id, ok := resp["agent_id"].(string); ok && id != "" {
		a.mu.Lock()
		if a.agentID == "" {
			a.agentID = id
			logger.Info(fmt.Sprintf("[%s] Resolved agent ID: %s", a.Config.Name, id))
		}
		a.mu.Unlock()
	}

	a.mu.Lock()
	currentMode := a.mode
	a.mu.Unlock()

	// When waiting for user input: check if the server has a reply ready.
	if currentMode == ModeWaitingInput {
		if reply, ok := resp["reply"].(string); ok && reply != "" {
			a.mu.Lock()
			pw := a.stdinWrite
			a.mu.Unlock()
			if pw != nil {
				if _, err := fmt.Fprintln(pw, reply); err != nil {
					logger.Warn(fmt.Sprintf("[%s] Failed to write reply to stdin: %v", a.Config.Name, err))
				} else {
					a.mu.Lock()
					a.mode = ModeRunning
					a.mu.Unlock()
					logger.Info(fmt.Sprintf("[%s] User replied — resuming", a.Config.Name))
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

// ── Task lifecycle ─────────────────────────────────────────────────────────────

// writeRunLog writes a timestamped line to the current per-task log file (if open).
func (a *Agent) writeRunLog(msg string) {
	a.mu.Lock()
	f := a.runLog
	a.mu.Unlock()
	if f == nil {
		return
	}
	fmt.Fprintf(f, "%s %s\n", time.Now().Format(time.RFC3339), msg)
}

// buildConversationPrompt constructs the prompt to send to the CLI provider.
// For a fresh task (single message), it uses that message directly.
// For a follow-up (multiple messages), it formats the full thread as a
// Human/Assistant conversation so the model has prior context.
func buildConversationPrompt(subject string, rawMsgs any) string {
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

func (a *Agent) startTask(cfg *config.Config, task map[string]any) {
	taskID, _ := task["id"].(string)
	subject, _ := task["subject"].(string)

	a.mu.Lock()
	a.mode = ModeRunning
	a.taskID = taskID
	a.outputLines = nil
	a.completing = false
	a.mu.Unlock()

	logger.Lifecycle(fmt.Sprintf("[%s] event=started task_id=%s subject=%q", a.Config.Name, taskID, subject))
	logger.Info(fmt.Sprintf("[%s] Starting task %s: \"%s\"", a.Config.Name, taskID, subject))

	// Open a per-task log file for the full run output.
	runLog, err := logger.CreateRunLog(a.Config.Name, taskID)
	if err != nil {
		logger.Warn(fmt.Sprintf("[%s] Could not create run log: %v", a.Config.Name, err))
	} else {
		fmt.Fprintf(runLog, "# TaskSquad run log\n# agent=%s  task_id=%s  subject=%s\n# started=%s\n\n",
			a.Config.Name, taskID, subject, time.Now().Format(time.RFC3339))
		a.mu.Lock()
		a.runLog = runLog
		a.mu.Unlock()
	}

	// Open session on the server.
	sessResp, err := a.post(cfg, "/daemon/session/open", map[string]any{
		"task_id": taskID,
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] Session open failed: %v", a.Config.Name, err))
		a.mu.Lock()
		a.mode = ModeIdle
		a.mu.Unlock()
		return
	}

	sessionID, _ := sessResp["session_id"].(string)
	a.mu.Lock()
	a.sessionID = sessionID
	a.mu.Unlock()

	// Let the provider write any hook/config files it needs (e.g. .claude/settings.json).
	if err := a.prov.Setup(a.Config.WorkDir, cfg.Hooks.Port); err != nil {
		logger.Warn(fmt.Sprintf("[%s] Provider setup warning: %v", a.Config.Name, err))
	}

	// Build prompt from the full conversation history.
	prompt := buildConversationPrompt(subject, task["messages"])

	// Spawn the command.
	// Providers that return a non-empty Stdin() receive the prompt via a pipe
	// kept open for the lifetime of the process so replies can be forwarded
	// back to the agent interactively. Others get the prompt via the -p flag.
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

	if stdinData != "" {
		pr, pw := io.Pipe()
		cmd.Stdin = pr
		a.mu.Lock()
		a.stdinWrite = pw
		a.mu.Unlock()
		// Write the initial prompt; the pipe stays open for future user replies.
		go func() {
			if _, err := fmt.Fprintln(pw, stdinData); err != nil {
				logger.Warn(fmt.Sprintf("[%s] Failed to write prompt to stdin: %v", a.Config.Name, err))
			}
		}()
	}

	// Merge provider env vars into the process environment.
	provEnv := a.prov.Env(cfg.Hooks.Port)
	if len(provEnv) > 0 {
		cmd.Env = append(os.Environ(), provEnv...)
	} else {
		cmd.Env = os.Environ()
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] StdoutPipe error: %v", a.Config.Name, err))
		a.mu.Lock()
		a.mode = ModeIdle
		a.mu.Unlock()
		return
	}
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		logger.Error(fmt.Sprintf("[%s] Spawn failed: %v", a.Config.Name, err))
		a.mu.Lock()
		a.mode = ModeIdle
		a.mu.Unlock()
		return
	}

	a.mu.Lock()
	a.proc = cmd
	agentID := a.agentID
	a.mu.Unlock()

	logger.Lifecycle(fmt.Sprintf("[%s] event=running task_id=%s pid=%d", a.Config.Name, taskID, cmd.Process.Pid))
	a.writeRunLog(fmt.Sprintf("[EVENT] event=running pid=%d", cmd.Process.Pid))

	// Drain stderr silently.
	go io.Copy(io.Discard, stderr)

	// Stream stdout lines to the server; close outputDone when finished so
	// complete() can wait for the full output before sending final_text.
	outputDone := make(chan struct{})
	a.mu.Lock()
	a.outputDone = outputDone
	a.mu.Unlock()
	go func() {
		a.streamOutput(cfg, agentID, stdout)
		close(outputDone)
	}()

	// Wait for process exit.
	// For hook-based providers the hook usually fires first; the completing
	// guard makes the process-exit path a safe no-op in that case.
	code := 0
	if err := cmd.Wait(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		}
	}

	// Close the stdin pipe now that the process has exited (safe no-op if already closed by complete()).
	a.mu.Lock()
	if pw := a.stdinWrite; pw != nil {
		pw.Close()
		a.stdinWrite = nil
	}
	a.mu.Unlock()

	logger.Info(fmt.Sprintf("[%s] Process exited (code %d)", a.Config.Name, code))
	logger.Lifecycle(fmt.Sprintf("[%s] event=exit code=%d task_id=%s", a.Config.Name, code, taskID))
	a.writeRunLog(fmt.Sprintf("[EVENT] event=exit code=%d", code))

	status := "closed"
	if code != 0 {
		status = "crashed"
	}
	a.complete(cfg, status)
}

func (a *Agent) streamOutput(cfg *config.Config, agentID string, r io.Reader) {
	a.mu.Lock()
	runLog := a.runLog
	a.mu.Unlock()

	scanner := bufio.NewScanner(r)
	var batch []string

	flush := func() {
		if len(batch) == 0 {
			return
		}
		a.mu.Lock()
		a.outputLines = append(a.outputLines, batch...)
		id := a.agentID
		a.mu.Unlock()

		// Write full output to the per-task run log.
		if runLog != nil {
			for _, line := range batch {
				fmt.Fprintln(runLog, line)
			}
		}

		if id != "" {
			a.post(cfg, "/daemon/push/"+id, map[string]any{ //nolint:errcheck
				"type":  "line",
				"lines": batch,
			})
		}
		batch = nil
	}

	for scanner.Scan() {
		batch = append(batch, scanner.Text())
		if len(batch) >= 10 {
			flush()
		}
	}
	flush()
}

// complete finalises the current task. Safe to call from both the hook handler
// and the process-exit path — the completing flag prevents double execution.
func (a *Agent) complete(cfg *config.Config, status string) {
	a.mu.Lock()
	if a.completing || a.sessionID == "" {
		a.mu.Unlock()
		return
	}
	a.completing = true
	sessionID := a.sessionID
	agentID := a.agentID
	taskID := a.taskID
	pw := a.stdinWrite
	a.stdinWrite = nil
	runLog := a.runLog
	a.runLog = nil
	outputDone := a.outputDone
	a.mu.Unlock()

	// Signal EOF to the process stdin (if still open) so it can exit cleanly.
	if pw != nil {
		pw.Close()
	}

	// Wait for stdout to finish draining before collecting output.
	// This is critical when the Stop hook fires mid-execution: the process
	// may still be writing its final response to stdout. Without this wait,
	// outputLines is incomplete and final_text ends up empty.
	if outputDone != nil {
		select {
		case <-outputDone:
		case <-time.After(15 * time.Second):
			logger.Warn(fmt.Sprintf("[%s] Timed out waiting for stdout drain (task %s)", a.Config.Name, taskID))
		}
	}

	a.mu.Lock()
	lines := append([]string(nil), a.outputLines...)
	a.mu.Unlock()

	logger.Info(fmt.Sprintf("[%s] Completing task %s — status=%s", a.Config.Name, taskID, status))

	// Emit lifecycle event based on final status.
	if status == "closed" {
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
	if runLog != nil {
		runLog.Close()
	}

	all := strings.Join(lines, "\n")
	finalText := strings.TrimSpace(all)
	if len(finalText) > 10000 {
		finalText = finalText[len(finalText)-10000:]
	}

	closeResp, err := a.post(cfg, "/daemon/session/close", map[string]any{
		"session_id": sessionID,
		"agent_id":   agentID,
		"status":     status,
		"final_text": finalText,
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] Session close error: %v", a.Config.Name, err))
	}

	// Push SSE "done" event to any portal viewers.
	if agentID != "" {
		a.post(cfg, "/daemon/push/"+agentID, map[string]any{ //nolint:errcheck
			"type":  "done",
			"lines": []string{finalText},
		})
	}

	// Upload full log to R2 when the server provides a presigned URL.
	if closeResp != nil {
		if uploadURL, ok := closeResp["upload_url"].(string); ok && uploadURL != "" {
			data := []byte(all)
			if err := api.PutBytes(uploadURL, data); err != nil {
				logger.Warn(fmt.Sprintf("[%s] R2 upload failed: %v", a.Config.Name, err))
			} else {
				logger.Info(fmt.Sprintf("[%s] Uploaded %d bytes to R2", a.Config.Name, len(data)))
			}
		}
	}

	a.mu.Lock()
	a.mode = ModeIdle
	a.sessionID = ""
	a.outputLines = nil
	a.outputDone = nil
	a.proc = nil
	a.completing = false
	a.mu.Unlock()
}

// Complete is called by the hook server when the provider emits a Stop event.
func (a *Agent) Complete(cfg *config.Config) {
	a.mu.Lock()
	mode := a.mode
	a.mu.Unlock()
	if mode == ModeIdle {
		return
	}
	a.complete(cfg, "closed")
}

// SetWaitingInput is called by the hook server on a Notification event.
// It does NOT close the session — the process keeps running so the user's
// reply can be piped back via stdin.
func (a *Agent) SetWaitingInput(cfg *config.Config, message string) {
	a.mu.Lock()
	mode := a.mode
	completing := a.completing
	agentID := a.agentID
	sessionID := a.sessionID
	a.mu.Unlock()

	// Ignore if not running or if complete() is already in progress (e.g. Stop
	// hook arrived just before this Notification hook was delivered).
	if mode != ModeRunning || completing {
		return
	}

	logger.Info(fmt.Sprintf("[%s] Waiting for user input: %s", a.Config.Name, message))

	// Notify SSE clients so the portal can display the question.
	if agentID != "" {
		a.post(cfg, "/daemon/push/"+agentID, map[string]any{ //nolint:errcheck
			"type":  "waiting_input",
			"lines": []string{message},
		})
	}

	// Tell the server to post the message as a thread reply and queue for user input.
	// The server should return {"reply": "..."} on the next heartbeat once the user responds.
	a.post(cfg, "/daemon/session/notify", map[string]any{ //nolint:errcheck
		"session_id": sessionID,
		"agent_id":   agentID,
		"message":    message,
	})

	a.mu.Lock()
	a.mode = ModeWaitingInput
	a.mu.Unlock()
}

package agent

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/provider"
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

// buildNotifyMessage extracts Claude's actual question from recent PTY output.
// The Notification hook only delivers a generic string ("Claude is waiting for
// your input"); the real question text lives in the terminal output captured by
// streamOutput. We take the last 15 non-empty output lines as the message so
// the user sees meaningful context in the portal thread.
func buildNotifyMessage(a *Agent, fallback string) string {
	a.mu.Lock()
	lines := append([]string(nil), a.outputLines...)
	a.mu.Unlock()

	var recent []string
	for i := len(lines) - 1; i >= 0 && len(recent) < 15; i-- {
		if s := strings.TrimSpace(lines[i]); s != "" {
			recent = append([]string{lines[i]}, recent...)
		}
	}
	if len(recent) == 0 {
		return fallback
	}
	return strings.Join(recent, "\n")
}

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
	stdinWrite  io.WriteCloser // open while process is running (pipe or PTY master)
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

	// Merge provider env vars into the process environment.
	provEnv := a.prov.Env(cfg.Hooks.Port)
	if len(provEnv) > 0 {
		cmd.Env = append(os.Environ(), provEnv...)
	} else {
		cmd.Env = os.Environ()
	}

	// outputDone is closed when the output reader goroutine finishes draining.
	outputDone := make(chan struct{})
	a.mu.Lock()
	a.outputDone = outputDone
	a.mu.Unlock()

	var outputReader io.Reader

	if stdinData != "" {
		// Use a PTY so the provider thinks it's in a real terminal and produces
		// full output: spinner, tool calls, diffs, colours — everything.
		ptmx, err := pty.Start(cmd)
		if err != nil {
			logger.Warn(fmt.Sprintf("[%s] PTY start failed, falling back to pipe: %v", a.Config.Name, err))
			// Fallback: plain pipe (no rich output, but still functional).
			pr, pw := io.Pipe()
			cmd.Stdin = pr
			a.mu.Lock()
			a.stdinWrite = pw
			a.mu.Unlock()
			go func() {
				if _, werr := fmt.Fprintln(pw, stdinData); werr != nil {
					logger.Warn(fmt.Sprintf("[%s] Failed to write prompt to stdin: %v", a.Config.Name, werr))
				}
			}()
			stdout, serr := cmd.StdoutPipe()
			if serr != nil {
				logger.Error(fmt.Sprintf("[%s] StdoutPipe error: %v", a.Config.Name, serr))
				a.mu.Lock()
				a.mode = ModeIdle
				a.mu.Unlock()
				close(outputDone)
				return
			}
			stderr, _ := cmd.StderrPipe()
			if serr = cmd.Start(); serr != nil {
				logger.Error(fmt.Sprintf("[%s] Spawn failed: %v", a.Config.Name, serr))
				a.mu.Lock()
				a.mode = ModeIdle
				a.mu.Unlock()
				close(outputDone)
				return
			}
			go io.Copy(io.Discard, stderr)
			outputReader = stdout
		} else {
			// PTY started successfully.
			// Set a wide terminal so progress bars / tables don't wrap.
			_ = pty.Setsize(ptmx, &pty.Winsize{Rows: 50, Cols: 220})

			a.mu.Lock()
			a.stdinWrite = ptmx // PTY master is both stdin and stdout
			a.mu.Unlock()

			// Write the initial prompt into the PTY; keep it open for future replies.
			go func() {
				if _, werr := fmt.Fprintln(ptmx, stdinData); werr != nil {
					logger.Warn(fmt.Sprintf("[%s] Failed to write prompt to PTY: %v", a.Config.Name, werr))
				}
			}()

			outputReader = ptmx
		}
	} else {
		// Non-stdin providers (e.g. codex): use regular stdout pipe with -p flag.
		stdout, serr := cmd.StdoutPipe()
		if serr != nil {
			logger.Error(fmt.Sprintf("[%s] StdoutPipe error: %v", a.Config.Name, serr))
			a.mu.Lock()
			a.mode = ModeIdle
			a.mu.Unlock()
			close(outputDone)
			return
		}
		stderr, _ := cmd.StderrPipe()
		if serr = cmd.Start(); serr != nil {
			logger.Error(fmt.Sprintf("[%s] Spawn failed: %v", a.Config.Name, serr))
			a.mu.Lock()
			a.mode = ModeIdle
			a.mu.Unlock()
			close(outputDone)
			return
		}
		go io.Copy(io.Discard, stderr)
		outputReader = stdout
	}

	a.mu.Lock()
	a.proc = cmd
	agentID := a.agentID
	a.mu.Unlock()

	logger.Lifecycle(fmt.Sprintf("[%s] event=running task_id=%s pid=%d", a.Config.Name, taskID, cmd.Process.Pid))
	a.writeRunLog(fmt.Sprintf("[EVENT] event=running pid=%d", cmd.Process.Pid))

	// Stream output lines to the server and log file.
	go func() {
		a.streamOutput(cfg, agentID, outputReader)
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

	flushPush := func() {
		if len(batch) == 0 {
			return
		}
		a.mu.Lock()
		id := a.agentID
		a.mu.Unlock()
		if id != "" {
			a.post(cfg, "/daemon/push/"+id, map[string]any{ //nolint:errcheck
				"type":  "line",
				"lines": batch,
			})
		}
		batch = nil
	}

	for scanner.Scan() {
		line := cleanLine(scanner.Text())
		if line == "" {
			continue // skip pure escape-sequence lines (TUI redraws, clear-screen, etc.)
		}

		// Append to outputLines immediately so SetWaitingInput can read the
		// latest content when the Notification hook fires.
		a.mu.Lock()
		a.outputLines = append(a.outputLines, line)
		a.mu.Unlock()

		// Write to the per-task run log immediately.
		if runLog != nil {
			fmt.Fprintln(runLog, line)
		}

		// Batch lines for server push.
		batch = append(batch, line)
		if len(batch) >= 10 {
			flushPush()
		}
	}
	flushPush()
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
// We only close stdin here so the process can exit cleanly; the actual
// completion status is determined by the exit code in startTask — this
// ensures a non-zero exit (e.g. "credit balance too low") is surfaced as
// failed rather than silently marked done.
func (a *Agent) Complete(cfg *config.Config) {
	a.mu.Lock()
	mode := a.mode
	pw := a.stdinWrite
	a.mu.Unlock()

	if mode == ModeIdle {
		return
	}

	// Close stdin so the process knows to exit after finishing its current turn.
	if pw != nil {
		a.mu.Lock()
		if a.stdinWrite != nil {
			a.stdinWrite = nil
		}
		a.mu.Unlock()
		pw.Close()
	}
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

	// Wait briefly for any PTY output still buffered in the kernel to be read
	// and appended to outputLines by the streamOutput goroutine.
	time.Sleep(300 * time.Millisecond)

	// Build the notification message from the last meaningful PTY output lines.
	// The Notification hook only sends a generic string ("Claude is waiting for
	// your input"); Claude's actual question is in the terminal output.
	notifyMsg := buildNotifyMessage(a, message)

	logger.Info(fmt.Sprintf("[%s] Waiting for user input: %s", a.Config.Name, notifyMsg))

	// Notify SSE clients so the portal can display the question.
	if agentID != "" {
		a.post(cfg, "/daemon/push/"+agentID, map[string]any{ //nolint:errcheck
			"type":  "waiting_input",
			"lines": []string{notifyMsg},
		})
	}

	// Tell the server to post the message as a thread reply and queue for user input.
	// The server should return {"reply": "..."} on the next heartbeat once the user responds.
	a.post(cfg, "/daemon/session/notify", map[string]any{ //nolint:errcheck
		"session_id": sessionID,
		"agent_id":   agentID,
		"message":    notifyMsg,
	})

	a.mu.Lock()
	a.mode = ModeWaitingInput
	a.mu.Unlock()
}

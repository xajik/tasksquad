package agent

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/provider"
)

// tmuxBin is the path to the tmux binary, or empty if tmux is not installed.
var tmuxBin string

func init() {
	if p, err := exec.LookPath("tmux"); err == nil {
		tmuxBin = p
	}
}

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
	tmuxSession    string // tmux session name while task is running (tmux path only)
	fifoPath       string // FIFO path for tmux output streaming
	transcriptPath string // Claude Code conversation transcript (from Stop hook payload)
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
			sess := a.tmuxSession
			pw := a.stdinWrite
			a.mu.Unlock()

			if sess != "" {
				// tmux path: deliver reply via send-keys
				exec.Command(tmuxBin, "send-keys", "-t", sess, reply, "Enter").Run() //nolint:errcheck
				a.mu.Lock()
				a.mode = ModeRunning
				a.mu.Unlock()
				logger.Info(fmt.Sprintf("[%s] User replied — resuming via tmux", a.Config.Name))
			} else if pw != nil {
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
	usingTmux := false

	// ── tmux path (preferred when tmux is available) ──────────────────────────
	if stdinData != "" && tmuxBin != "" {
		sessionSuffix := taskID
		if len(sessionSuffix) > 8 {
			sessionSuffix = sessionSuffix[:8]
		}
		sessionName := fmt.Sprintf("ts-%s", sessionSuffix)
		fifoPath := fmt.Sprintf("/tmp/ts-%s.fifo", sessionSuffix)
		os.Remove(fifoPath)

		if err := syscall.Mkfifo(fifoPath, 0644); err != nil {
			logger.Warn(fmt.Sprintf("[%s] mkfifo failed: %v — falling back to PTY", a.Config.Name, err))
		} else {
			// Build tmux new-session: inherit workDir + provider env.
			cmdParts := append([]string{parts[0]}, args...)
			newSessionArgs := append([]string{"new-session", "-d", "-s", sessionName,
				"-c", a.Config.WorkDir, "-x", "220", "-y", "50", "--"}, cmdParts...)
			tmuxCmd := exec.Command(tmuxBin, newSessionArgs...)
			if len(provEnv) > 0 {
				tmuxCmd.Env = append(os.Environ(), provEnv...)
			} else {
				tmuxCmd.Env = os.Environ()
			}

			if err := tmuxCmd.Run(); err != nil {
				logger.Warn(fmt.Sprintf("[%s] tmux new-session failed: %v — falling back to PTY", a.Config.Name, err))
				os.Remove(fifoPath)
			} else {
				// Open FIFO for reading concurrently — blocks until writer opens it.
				fifoCh := make(chan *os.File, 1)
				go func() {
					f, err := os.Open(fifoPath)
					if err != nil {
						return
					}
					fifoCh <- f
				}()

				// pipe-pane runs `cat > fifoPath` inside the session, which opens the
				// FIFO for writing and unblocks the reader goroutine above.
				exec.Command(tmuxBin, "pipe-pane", "-t", sessionName, "cat > "+fifoPath).Run() //nolint:errcheck

				// Deliver the initial prompt.
				exec.Command(tmuxBin, "send-keys", "-t", sessionName, stdinData, "Enter").Run() //nolint:errcheck

				a.mu.Lock()
				a.tmuxSession = sessionName
				a.fifoPath = fifoPath
				a.mu.Unlock()

				logger.Info(fmt.Sprintf("[%s] tmux session started — attach: tmux attach-session -t %s", a.Config.Name, sessionName))

				select {
				case f := <-fifoCh:
					outputReader = f
					usingTmux = true
				case <-time.After(5 * time.Second):
					logger.Warn(fmt.Sprintf("[%s] FIFO open timed out — falling back to PTY", a.Config.Name))
					exec.Command(tmuxBin, "kill-session", "-t", sessionName).Run() //nolint:errcheck
					os.Remove(fifoPath)
					a.mu.Lock()
					a.tmuxSession = ""
					a.fifoPath = ""
					a.mu.Unlock()
				}
			}
		}
	}

	// ── PTY / pipe path (fallback when tmux unavailable or failed) ────────────
	if !usingTmux {
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
	}

	a.mu.Lock()
	if !usingTmux {
		a.proc = cmd
	}
	agentID := a.agentID
	a.mu.Unlock()

	if usingTmux {
		sessionSuffix := taskID
		if len(sessionSuffix) > 8 {
			sessionSuffix = sessionSuffix[:8]
		}
		logger.Lifecycle(fmt.Sprintf("[%s] event=running task_id=%s via=tmux session=ts-%s", a.Config.Name, taskID, sessionSuffix))
		a.writeRunLog("[EVENT] event=running via=tmux")
	} else {
		logger.Lifecycle(fmt.Sprintf("[%s] event=running task_id=%s pid=%d", a.Config.Name, taskID, cmd.Process.Pid))
		a.writeRunLog(fmt.Sprintf("[EVENT] event=running pid=%d", cmd.Process.Pid))
	}

	// Stream output lines to the server and log file.
	go func() {
		a.streamOutput(cfg, agentID, outputReader)
		close(outputDone)
	}()

	if usingTmux {
		// Block until the FIFO closes — happens when the tmux session ends
		// (naturally or killed by Complete() via the Stop hook).
		<-outputDone
		// complete() may have already been called by Complete() if the Stop hook
		// fired first. The completing flag makes double-calls a safe no-op.
		a.complete(cfg, "closed")
		return
	}

	// ── PTY / pipe path: wait for process exit ────────────────────────────────
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

// ExtractTranscriptResponse reads Claude Code's JSONL conversation transcript
// and returns the text of the last assistant message. Returns empty string on
// any read or parse error so callers can fall back to terminal output.
func ExtractTranscriptResponse(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}

	// Each line is a JSON object. Scan forward and keep overwriting lastText
	// so we end up with the final assistant message.
	var lastText string
	for _, rawLine := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		rawLine = strings.TrimSpace(rawLine)
		if rawLine == "" {
			continue
		}
		var entry struct {
			Type    string `json:"type"`
			Message struct {
				Role    string `json:"role"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal([]byte(rawLine), &entry); err != nil {
			continue
		}
		isAssistant := entry.Type == "assistant" ||
			(entry.Message.Role == "assistant")
		if !isAssistant {
			continue
		}
		var parts []string
		for _, c := range entry.Message.Content {
			if c.Type == "text" && c.Text != "" {
				parts = append(parts, c.Text)
			}
		}
		if len(parts) > 0 {
			lastText = strings.Join(parts, "\n")
		}
	}
	return strings.TrimSpace(lastText)
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
	sess := a.tmuxSession
	fifo := a.fifoPath
	transcriptPath := a.transcriptPath
	a.tmuxSession = ""
	a.fifoPath = ""
	a.transcriptPath = ""
	a.mu.Unlock()

	// For tmux path: kill the session so the FIFO writer (cat) closes, which
	// causes streamOutput's scanner to get EOF and outputDone to be closed.
	// For PTY path: close stdin so the process can exit cleanly.
	if sess != "" {
		exec.Command(tmuxBin, "kill-session", "-t", sess).Run() //nolint:errcheck
	} else if pw != nil {
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

	// Prefer the transcript for final_text: Claude Code's TUI output captured via
	// tmux pipe-pane contains raw VT100 sequences that cleanLine cannot fully
	// reconstruct into readable text. The Stop hook provides transcript_path, a
	// JSONL file with the clean conversation — we extract the last assistant turn.
	finalText := ""
	if transcriptPath != "" {
		finalText = ExtractTranscriptResponse(transcriptPath)
		if finalText != "" {
			logger.Info(fmt.Sprintf("[%s] Final text from transcript (%d chars)", a.Config.Name, len(finalText)))
		} else {
			logger.Warn(fmt.Sprintf("[%s] Transcript read returned empty, falling back to terminal output", a.Config.Name))
		}
	}
	if finalText == "" {
		finalText = strings.TrimSpace(all)
		if len(finalText) > 10000 {
			finalText = finalText[len(finalText)-10000:]
		}
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

	// Remove the FIFO now that all output has been drained.
	if fifo != "" {
		os.Remove(fifo)
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
// For the tmux path it kills the tmux session (which closes the FIFO writer,
// draining the last output) and then calls complete() with the hook-supplied
// status. For the PTY path it closes stdin and lets cmd.Wait() in startTask
// determine the exit code and call complete() from there.
func (a *Agent) Complete(cfg *config.Config, status string, transcriptPath string) {
	a.mu.Lock()
	mode := a.mode
	pw := a.stdinWrite
	sess := a.tmuxSession
	if transcriptPath != "" {
		a.transcriptPath = transcriptPath
	}
	a.mu.Unlock()

	if mode == ModeIdle {
		return
	}

	if sess != "" {
		// tmux path: kill session → FIFO writer closes → streamOutput exits →
		// outputDone closes → startTask unblocks and calls complete() (no-op).
		// We also call complete() directly here with the hook-supplied status so
		// the stop_reason from Claude Code is honoured even if startTask hasn't
		// yet unblocked. The completing flag makes double-calls a safe no-op.
		exec.Command(tmuxBin, "kill-session", "-t", sess).Run() //nolint:errcheck
		a.mu.Lock()
		a.tmuxSession = "" // prevent complete() from killing the already-dead session
		a.mu.Unlock()
		go a.complete(cfg, status)
		return
	}

	// PTY path: close stdin so the process exits → cmd.Wait() returns →
	// startTask calls complete() with the exit-code-derived status.
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

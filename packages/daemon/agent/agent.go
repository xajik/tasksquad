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
	"time"

	"github.com/creack/pty"
	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
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
	a.mu.Lock()
	sess := a.tmuxSession
	lines := append([]string(nil), a.outputLines...)
	prompt := a.lastPrompt
	a.mu.Unlock()

	var visible []string

	if sess != "" && tmuxBin != "" {
		out, err := exec.Command(tmuxBin, "capture-pane", "-t", sess, "-p").Output()
		if err == nil {
			for _, raw := range strings.Split(string(out), "\n") {
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
	// We check if the line contains a significant portion of the prompt
	// or vice versa, to handle cases where the terminal adds "> " or wraps it.
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

	// If everything was filtered out, it means the agent hasn't produced
	// anything yet except for echoing the prompt. Fall back to the original message.
	return fallback
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

	mu             sync.Mutex
	mode           Mode
	paused         bool   // when true, heartbeat is skipped
	agentID        string // resolved from server on first heartbeat
	sessionID      string
	taskID         string
	outputLines    []string
	completing     bool
	proc           *exec.Cmd
	stdinWrite     io.WriteCloser // open while process is running (pipe or PTY master)
	runLog         *os.File       // per-task log file, open while task runs
	outputDone     chan struct{}  // closed when streamOutput finishes draining stdout
	tmuxSession    string         // tmux session name while task is running (tmux path only)
	fifoPath       string         // FIFO path for tmux output streaming
	transcriptPath string         // Claude Code conversation transcript (from Stop hook payload)
	lastPrompt     string         // the initial prompt or latest user reply sent to the process
	lastPollAt     time.Time      // time of the last successful heartbeat
	lastLogPath    string         // path to the current per-task run log file
}

func New(cfg config.AgentConfig) *Agent {
	return &Agent{
		Config:  cfg,
		agentID: cfg.ID, // known upfront from config (set during tsq init)
		mode:    ModeIdle,
		prov:    provider.Detect(cfg.Command, cfg.Provider),
	}
}

// Name implements the ui.AgentStatus interface.
func (a *Agent) Name() string { return a.Config.Name }

// ID returns the server-assigned agent ID. Used to identify hooks uniquely
// even when multiple agents share the same display name.
func (a *Agent) ID() string { return a.Config.ID }

// AgentID implements ui.AgentStatus — same as ID().
func (a *Agent) AgentID() string { return a.Config.ID }

// WorkDir implements ui.AgentStatus — returns the configured working directory.
func (a *Agent) WorkDir() string { return a.Config.WorkDir }

// Command implements ui.AgentStatus — returns the CLI command string.
func (a *Agent) Command() string { return a.Config.Command }

// Provider implements ui.AgentStatus — returns the provider name.
func (a *Agent) Provider() string { return a.prov.Name() }

// GetMode implements the hooks.Agent and ui.AgentStatus interfaces.
func (a *Agent) GetMode() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return string(a.mode)
}

func (a *Agent) GetTaskID() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.taskID
}

// Pause stops the heartbeat poll loop until Resume is called.
func (a *Agent) Pause() {
	a.mu.Lock()
	a.paused = true
	a.mu.Unlock()
	logger.Info(fmt.Sprintf("[%s] Pulling paused", a.Config.Name))
}

// Resume re-enables the heartbeat poll loop.
func (a *Agent) Resume() {
	a.mu.Lock()
	a.paused = false
	a.mu.Unlock()
	logger.Info(fmt.Sprintf("[%s] Pulling resumed", a.Config.Name))
}

// IsPaused reports whether the poll loop is currently paused.
func (a *Agent) IsPaused() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.paused
}

// LastPullTime implements ui.AgentStatus — returns the time of the last successful heartbeat.
func (a *Agent) LastPullTime() time.Time {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lastPollAt
}

// LastLogPath implements ui.AgentStatus — returns the path to the current run log file.
func (a *Agent) LastLogPath() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lastLogPath
}

// TmuxSession implements ui.AgentStatus — returns the active tmux session name.
func (a *Agent) TmuxSession() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.tmuxSession
}

func (a *Agent) post(cfg *config.Config, path string, body any) (map[string]any, error) {
	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		return nil, fmt.Errorf("auth: %w", err)
	}
	return api.Post(cfg, token, a.Config.ID, path, body)
}

// processResponse dispatches a single heartbeat response: resolves the agent ID,
// handles control signals (reset/cancel/close/reply), and starts pending tasks.
// Called by both heartbeat() and RunBatch().
func (a *Agent) processResponse(cfg *config.Config, resp map[string]any) {
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

	// Reset requested from portal — kill tmux and go idle regardless of current mode.
	// In-progress tasks have already been completed server-side.
	if reset, _ := resp["reset"].(bool); reset {
		logger.Info(fmt.Sprintf("[%s] Reset requested by server — killing tmux sessions and going idle", a.Config.Name))
		go a.handleReset()
		return
	}

	// When running or waiting for input: check if the server signalled a cancel or close.
	if currentMode == ModeRunning || currentMode == ModeWaitingInput {
		if cancel, _ := resp["cancel"].(bool); cancel {
			logger.Info(fmt.Sprintf("[%s] Task cancelled by server", a.Config.Name))
			go a.Complete(cfg, "cancelled", "")
			return
		}
		if close_, _ := resp["close"].(bool); close_ {
			logger.Info(fmt.Sprintf("[%s] Session closed by server (user completed)", a.Config.Name))
			go a.closeSession(cfg)
			return
		}
	}

	// When waiting for user input: check if the server has a reply ready.
	if currentMode == ModeWaitingInput {
		if reply, ok := resp["reply"].(string); ok && reply != "" {
			a.mu.Lock()
			sess := a.tmuxSession
			pw := a.stdinWrite
			a.mu.Unlock()

			if sess != "" {
				// tmux path: deliver reply via send-keys
				// Small delay to ensure tmux session is ready to receive input.
				time.Sleep(1 * time.Second)
				exec.Command(tmuxBin, "send-keys", "-t", sess, reply).Run() //nolint:errcheck
				time.Sleep(1 * time.Second)
				exec.Command(tmuxBin, "send-keys", "-t", sess, "C-m").Run() //nolint:errcheck
				a.mu.Lock()
				a.mode = ModeRunning
				a.lastPrompt = reply
				a.mu.Unlock()
				logger.Info(fmt.Sprintf("[%s] User replied — resuming via tmux", a.Config.Name))
			} else if pw != nil {
				if _, err := fmt.Fprintln(pw, reply); err != nil {
					logger.Warn(fmt.Sprintf("[%s] Failed to write reply to stdin: %v", a.Config.Name, err))
				} else {
					a.mu.Lock()
					a.mode = ModeRunning
					a.lastPrompt = reply
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
		a.lastLogPath = runLog.Name()
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
	if err := a.prov.Setup(a.Config.WorkDir, cfg.Hooks.Port, a.Config.ID, taskID); err != nil {
		logger.Warn(fmt.Sprintf("[%s] Provider setup warning: %v", a.Config.Name, err))
	}

	// Build prompt from the full conversation history.
	prompt := buildConversationPrompt(subject, task["messages"])
	a.mu.Lock()
	a.lastPrompt = prompt
	a.mu.Unlock()

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
		sessionName := fmt.Sprintf("tsq-%s", sessionSuffix)
		fifoPath := fmt.Sprintf("/tmp/tsq-%s.fifo", sessionSuffix)
		os.Remove(fifoPath)

		if err := mkfifo(fifoPath, 0644); err != nil {
			logger.Warn(fmt.Sprintf("[%s] mkfifo failed: %v — falling back to PTY", a.Config.Name, err))
		} else {
			// Build tmux new-session: inherit workDir + provider env.
			cmdParts := append([]string{parts[0]}, args...)
			newSessionArgs := append([]string{"new-session", "-d", "-s", sessionName,
				"-c", a.Config.WorkDir, "--"}, cmdParts...)
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
				// Gemini requires extra time to initialize its internal state.
				time.Sleep(15 * time.Second)
				exec.Command(tmuxBin, "send-keys", "-t", sessionName, stdinData).Run() //nolint:errcheck
				time.Sleep(1 * time.Second)
				exec.Command(tmuxBin, "send-keys", "-t", sessionName, "C-m").Run() //nolint:errcheck

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
		logger.Lifecycle(fmt.Sprintf("[%s] event=running task_id=%s via=tmux session=tsq-%s", a.Config.Name, taskID, sessionSuffix))
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
		a.complete(cfg, "")
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

// uploadAndAttach gets a presigned R2 PUT URL, uploads the local file, then
// attaches the stored key to the message record.
func (a *Agent) uploadAndAttach(cfg *config.Config, sessionID, messageID, filename, filePath string) {
	if messageID == "" || filePath == "" {
		return
	}

	// 1. Get presigned URL
	resp, err := a.post(cfg, "/daemon/r2/presign", map[string]any{
		"session_id": sessionID,
		"filename":   filename,
	})
	if err != nil {
		logger.Warn(fmt.Sprintf("[%s] Failed to get presigned URL for %s: %v", a.Config.Name, filename, err))
		return
	}

	uploadURL, _ := resp["upload_url"].(string)
	key, _ := resp["key"].(string)
	dek, _ := resp["dek"].(string)
	if uploadURL == "" || key == "" {
		logger.Warn(fmt.Sprintf("[%s] Presign response missing URL or key for %s", a.Config.Name, filename))
		return
	}

	// 2. Upload file directly to R2
	data, err := os.ReadFile(filePath)
	if err != nil {
		logger.Warn(fmt.Sprintf("[%s] Could not read file for upload %s: %v", a.Config.Name, filePath, err))
		return
	}

	// Optional encryption
	if dek != "" {
		data, err = api.EncryptGCM(dek, data)
		if err != nil {
			logger.Warn(fmt.Sprintf("[%s] Encryption failed for %s: %v", a.Config.Name, filename, err))
			return
		}
	}

	if err := api.PutBytes(uploadURL, data); err != nil {
		logger.Warn(fmt.Sprintf("[%s] R2 upload failed for %s: %v", a.Config.Name, filename, err))
		return
	}
	logger.Info(fmt.Sprintf("[%s] Uploaded %d bytes to R2: %s", a.Config.Name, len(data), filename))

	// 3. Attach key to message
	_, err = a.post(cfg, "/daemon/messages/"+messageID+"/attach", map[string]any{
		"transcript_key": key,
	})
	if err != nil {
		logger.Warn(fmt.Sprintf("[%s] Failed to attach R2 key %s to message %s: %v", a.Config.Name, key, messageID, err))
	} else {
		logger.Debug(fmt.Sprintf("[%s] Attached R2 key %s to message %s", a.Config.Name, key, messageID))
	}
}

// uploadAndAttachContent uploads raw bytes to R2 and attaches the key to a message.
// Unlike uploadAndAttach (which reads from a file), this takes the content directly.
func (a *Agent) uploadAndAttachContent(cfg *config.Config, sessionID, messageID, filename string, content []byte) {
	if messageID == "" || len(content) == 0 {
		return
	}

	resp, err := a.post(cfg, "/daemon/r2/presign", map[string]any{
		"session_id": sessionID,
		"filename":   filename,
	})
	if err != nil {
		logger.Warn(fmt.Sprintf("[%s] Failed to get presigned URL for %s: %v", a.Config.Name, filename, err))
		return
	}

	uploadURL, _ := resp["upload_url"].(string)
	key, _ := resp["key"].(string)
	dek, _ := resp["dek"].(string)
	if uploadURL == "" || key == "" {
		logger.Warn(fmt.Sprintf("[%s] Presign response missing URL or key for %s", a.Config.Name, filename))
		return
	}

	// Optional encryption
	if dek != "" {
		var err error
		content, err = api.EncryptGCM(dek, content)
		if err != nil {
			logger.Warn(fmt.Sprintf("[%s] Encryption failed for %s: %v", a.Config.Name, filename, err))
			return
		}
	}

	if err := api.PutBytes(uploadURL, content); err != nil {
		logger.Warn(fmt.Sprintf("[%s] R2 upload failed for %s: %v", a.Config.Name, filename, err))
		return
	}
	logger.Info(fmt.Sprintf("[%s] Uploaded %d bytes to R2: %s", a.Config.Name, len(content), filename))

	_, err = a.post(cfg, "/daemon/messages/"+messageID+"/attach", map[string]any{
		"transcript_key": key,
	})
	if err != nil {
		logger.Warn(fmt.Sprintf("[%s] Failed to attach R2 key %s to message %s: %v", a.Config.Name, key, messageID, err))
	} else {
		logger.Debug(fmt.Sprintf("[%s] Attached R2 key %s to message %s", a.Config.Name, key, messageID))
	}
}

func (a *Agent) uploadAndAttachLog(cfg *config.Config, sessionID, logContent string) {
	if sessionID == "" || logContent == "" {
		return
	}

	// 1. Get presigned URL
	resp, err := a.post(cfg, "/daemon/r2/presign", map[string]any{
		"session_id": sessionID,
		"filename":   "full.log",
	})
	if err != nil {
		logger.Warn(fmt.Sprintf("[%s] Failed to get presigned URL for log: %v", a.Config.Name, err))
		return
	}

	uploadURL, _ := resp["upload_url"].(string)
	key, _ := resp["key"].(string)
	dek, _ := resp["dek"].(string)
	if uploadURL == "" || key == "" {
		logger.Warn(fmt.Sprintf("[%s] Presign response missing URL or key for log", a.Config.Name))
		return
	}

	// 2. Upload log directly to R2
	data := []byte(logContent)
	if dek != "" {
		var err error
		data, err = api.EncryptGCM(dek, data)
		if err != nil {
			logger.Warn(fmt.Sprintf("[%s] Encryption failed for log: %v", a.Config.Name, err))
			return
		}
	}

	if err := api.PutBytes(uploadURL, data); err != nil {
		logger.Warn(fmt.Sprintf("[%s] R2 log upload failed: %v", a.Config.Name, err))
		return
	}
	logger.Info(fmt.Sprintf("[%s] Uploaded %d bytes log to R2", a.Config.Name, len(logContent)))

	// 3. Attach key to session
	_, err = a.post(cfg, "/daemon/sessions/"+sessionID+"/attach", map[string]any{
		"r2_log_key": key,
	})
	if err != nil {
		logger.Warn(fmt.Sprintf("[%s] Failed to attach R2 log key to session: %v", a.Config.Name, err))
	}
}

// ExtractTranscriptResponse reads a JSONL or JSON conversation transcript (Claude or Gemini)
// and returns the text of the last assistant message. Returns empty string on
// any read or parse error so callers can fall back to terminal output.
func ExtractTranscriptResponse(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}

	content := strings.TrimSpace(string(data))
	if content == "" {
		return ""
	}

	// Handle Gemini's single-JSON format: {"messages": [{"type": "gemini", "content": "..."}]}
	if content[0] == '{' {
		var transcript struct {
			Messages []struct {
				Type    string `json:"type"`
				Content any    `json:"content"` // can be string or array
			} `json:"messages"`
		}
		if err := json.Unmarshal([]byte(content), &transcript); err == nil && len(transcript.Messages) > 0 {
			// Find the last assistant message
			for i := len(transcript.Messages) - 1; i >= 0; i-- {
				m := transcript.Messages[i]
				if m.Type == "gemini" || m.Type == "assistant" {
					if s, ok := m.Content.(string); ok {
						return strings.TrimSpace(s)
					}
					// If it's a list of content blocks (like Claude's internal structure)
					if list, ok := m.Content.([]any); ok {
						var parts []string
						for _, block := range list {
							if b, ok := block.(map[string]any); ok {
								if text, ok := b["text"].(string); ok {
									parts = append(parts, text)
								}
							}
						}
						return strings.TrimSpace(strings.Join(parts, "\n"))
					}
				}
			}
		}
	}

	// Handle Claude's JSONL format
	var lastText string
	for _, rawLine := range strings.Split(content, "\n") {
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

	a.internalComplete(cfg, status, sessionID, agentID, taskID, pw, runLog, outputDone, sess, fifo, transcriptPath)
}

// handleReset kills any running tmux session and returns the agent to idle.
// The server has already marked in-progress tasks as done; we must NOT call
// complete/sessionClose here as the server-side state is already settled.
// The agent becomes idle and will start pulling new tasks on its next heartbeat.
func (a *Agent) handleReset() {
	a.mu.Lock()
	sess := a.tmuxSession
	fifo := a.fifoPath
	pw := a.stdinWrite
	a.stdinWrite = nil
	a.tmuxSession = ""
	a.fifoPath = ""
	a.transcriptPath = ""
	a.sessionID = ""
	a.taskID = ""
	a.completing = false
	a.mode = ModeIdle
	a.mu.Unlock()

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

func (a *Agent) internalComplete(cfg *config.Config, status, sessionID, agentID, taskID string, pw io.WriteCloser, runLog *os.File, outputDone chan struct{}, sess, fifo, transcriptPath string) {
	logger.Info(fmt.Sprintf("[%s] internalComplete called — status=%q taskID=%s transcriptPath=%q", a.Config.Name, status, taskID, transcriptPath))
	if status == "" {
		status = "closed"
	}

	// For tmux path: capture the full scrollback before killing the session.
	// tmux capture-pane -S - reads from the beginning of the scrollback buffer,
	// giving us everything Claude printed — loading, tool descriptions, final response.
	// This must happen before kill-session which destroys the scrollback.
	var tmuxCapture string
	if sess != "" && tmuxBin != "" {
		if out, err := exec.Command(tmuxBin, "capture-pane", "-t", sess, "-p", "-S", "-").Output(); err == nil {
			tmuxCapture = strings.TrimSpace(string(out))
			logger.Info(fmt.Sprintf("[%s] Captured %d chars from tmux scrollback", a.Config.Name, len(tmuxCapture)))
		} else {
			logger.Warn(fmt.Sprintf("[%s] tmux capture-pane failed: %v", a.Config.Name, err))
		}
	}

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
	// NOTE: Claude fires the Stop hook while still finishing the transcript write.
	// We retry for up to 10 seconds to wait for the assistant response to appear.
	finalText := ""
	if transcriptPath != "" {
		retryDeadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(retryDeadline) {
			finalText = ExtractTranscriptResponse(transcriptPath)
			if finalText != "" {
				logger.Info(fmt.Sprintf("[%s] Final text from transcript (%d chars)", a.Config.Name, len(finalText)))
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		if finalText == "" {
			logger.Warn(fmt.Sprintf("[%s] Transcript read returned empty after 10s, falling back to terminal output", a.Config.Name))
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
	} else {
		logger.Debug(fmt.Sprintf("[%s] Session close response: %v", a.Config.Name, closeResp))

		// Asynchronously upload full log and transcript
		msgID, _ := closeResp["message_id"].(string)

		// 1. Upload execution log — prefer tmux scrollback (complete terminal output
		//    including tool descriptions), fall back to FIFO-captured cleaned lines.
		logContent := all
		if tmuxCapture != "" {
			logContent = tmuxCapture
		}
		go a.uploadAndAttachLog(cfg, sessionID, logContent)

		// 2. Upload execution transcript for the portal viewer.
		//    Prefer tmux scrollback (plain text, shows everything the terminal showed).
		//    Fall back to the Claude Code JSONL (only has the final API response).
		if msgID != "" {
			if tmuxCapture != "" {
				go a.uploadAndAttachContent(cfg, sessionID, msgID, "transcript.txt", []byte(tmuxCapture))
			} else if transcriptPath != "" {
				go a.uploadAndAttach(cfg, sessionID, msgID, "transcript.jsonl", transcriptPath)
			}
		}
	}

	// Push SSE "done" event to any portal viewers.
	if agentID != "" {
		a.post(cfg, "/daemon/push/"+agentID, map[string]any{ //nolint:errcheck
			"type":  "done",
			"lines": []string{finalText},
		})
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
	if transcriptPath == "" {
		transcriptPath = a.transcriptPath
	}
	a.tmuxSession = ""
	a.fifoPath = ""
	a.transcriptPath = ""
	a.mu.Unlock()

	go a.internalComplete(cfg, status, sessionID, agentID, taskID, pw, runLog, outputDone, sess, fifo, transcriptPath)
}

// StopAndPause is called by the hook server when Claude Code's Stop hook fires
// and the stop_reason is not "error". Instead of killing the tmux session and
// closing the task, it posts the final response as an agent message and moves
// to waiting_input — keeping the tmux session alive so the user can send a
// follow-up or click "Complete session" to cleanly shut down.
func (a *Agent) StopAndPause(cfg *config.Config, hookMessage, transcriptPath string) {
	a.mu.Lock()
	mode := a.mode
	completing := a.completing
	sessionID := a.sessionID
	agentID := a.agentID
	sess := a.tmuxSession
	a.mu.Unlock()

	if mode != ModeRunning || completing {
		logger.Debug(fmt.Sprintf("[%s] StopAndPause ignored: mode=%s completing=%v", a.Config.Name, mode, completing))
		return
	}

	// Wait briefly for FIFO output to drain.
	time.Sleep(300 * time.Millisecond)

	// Capture full tmux scrollback for the transcript upload.
	var tmuxCapture string
	if sess != "" && tmuxBin != "" {
		if out, err := exec.Command(tmuxBin, "capture-pane", "-t", sess, "-p", "-S", "-").Output(); err == nil {
			tmuxCapture = strings.TrimSpace(string(out))
			logger.Info(fmt.Sprintf("[%s] Captured %d chars from tmux scrollback", a.Config.Name, len(tmuxCapture)))
		} else {
			logger.Warn(fmt.Sprintf("[%s] tmux capture-pane failed: %v", a.Config.Name, err))
		}
	}

	// Extract final response text.
	// Priority: hookMessage (OpenCode plugin delivers clean text) → transcript → tmux scrollback → outputLines.
	finalText := hookMessage
	if finalText == "" && transcriptPath != "" {
		// Retry for up to 10 s because Claude Code may still be writing the transcript.
		retryDeadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(retryDeadline) {
			finalText = ExtractTranscriptResponse(transcriptPath)
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
		a.mu.Lock()
		lines := append([]string(nil), a.outputLines...)
		a.mu.Unlock()
		finalText = strings.TrimSpace(strings.Join(lines, "\n"))
		if len(finalText) > 10000 {
			finalText = finalText[len(finalText)-10000:]
		}
	}

	// Post the final response as an agent message and set task to waiting_input.
	notifyResp, err := a.post(cfg, "/daemon/session/notify", map[string]any{
		"session_id": sessionID,
		"agent_id":   agentID,
		"message":    finalText,
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] StopAndPause notify error: %v", a.Config.Name, err))
	} else if notifyResp != nil {
		msgID, _ := notifyResp["message_id"].(string)
		if msgID != "" {
			if tmuxCapture != "" {
				go a.uploadAndAttachContent(cfg, sessionID, msgID, "transcript.txt", []byte(tmuxCapture))
			} else if transcriptPath != "" {
				go a.uploadAndAttach(cfg, sessionID, msgID, "transcript.jsonl", transcriptPath)
			}
		}
	}

	// Upload execution log.
	a.mu.Lock()
	lines := append([]string(nil), a.outputLines...)
	a.mu.Unlock()
	logContent := strings.Join(lines, "\n")
	if tmuxCapture != "" {
		logContent = tmuxCapture
	}
	go a.uploadAndAttachLog(cfg, sessionID, logContent)

	// Push SSE event so portal viewers see the new state.
	if agentID != "" {
		a.post(cfg, "/daemon/push/"+agentID, map[string]any{ //nolint:errcheck
			"type":  "waiting_input",
			"lines": []string{finalText},
		})
	}

	a.mu.Lock()
	if transcriptPath != "" {
		a.transcriptPath = transcriptPath
	}
	a.mode = ModeWaitingInput
	a.mu.Unlock()

	logger.Info(fmt.Sprintf("[%s] Paused after response — tmux session kept alive, waiting for reply or close", a.Config.Name))
}

// closeSession is called by heartbeat when the server sends a "close" signal,
// meaning the user clicked "Complete session" in the portal. It kills the tmux
// session and resets the agent to idle WITHOUT calling /daemon/session/close
// (the server already closed the session and task).
func (a *Agent) closeSession(cfg *config.Config) {
	a.mu.Lock()
	sess := a.tmuxSession
	fifo := a.fifoPath
	runLog := a.runLog
	agentID := a.agentID
	// Clear all session state. complete() will be called by the startTask
	// goroutine once outputDone closes, but will be a safe no-op because
	// sessionID is empty.
	a.tmuxSession = ""
	a.fifoPath = ""
	a.sessionID = ""
	a.transcriptPath = ""
	a.mode = ModeIdle
	a.outputLines = nil
	a.runLog = nil
	a.mu.Unlock()

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

	// Push SSE "done" event so the portal drops out of "waiting for input" state.
	if agentID != "" {
		a.post(cfg, "/daemon/push/"+agentID, map[string]any{ //nolint:errcheck
			"type": "done",
		})
	}
}

// SetWaitingInput is called by the hook server on a Notification event.
// It does NOT close the session — the process keeps running so the user's
// reply can be piped back via stdin.
func (a *Agent) SetWaitingInput(cfg *config.Config, message string, transcriptPath string) {
	logger.Info(fmt.Sprintf("[%s] SetWaitingInput called — message=%q transcript_path=%q", a.Config.Name, message, transcriptPath))
	a.mu.Lock()
	mode := a.mode
	completing := a.completing
	agentID := a.agentID
	sessionID := a.sessionID
	a.mu.Unlock()

	// Ignore if not running or if complete() is already in progress (e.g. Stop
	// hook arrived just before this Notification hook was delivered).
	if mode != ModeRunning || completing {
		logger.Debug(fmt.Sprintf("[%s] SetWaitingInput ignored: mode=%s completing=%v", a.Config.Name, mode, completing))
		return
	}

	// Wait briefly for any PTY output still buffered in the kernel to be read
	// and appended to outputLines by the streamOutput goroutine.
	time.Sleep(300 * time.Millisecond)

	// Build the notification message from the last meaningful PTY output lines.
	// The Notification hook only sends a generic string ("Claude is waiting for
	// your input"); Claude's actual question is in the terminal output.
	// We prefer the transcript if available and ready.
	notifyMsg := ""
	if transcriptPath != "" {
		retryDeadline := time.Now().Add(3 * time.Second) // shorter timeout for notification
		for time.Now().Before(retryDeadline) {
			notifyMsg = ExtractTranscriptResponse(transcriptPath)
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

	// Tell the server to post the message as a thread reply and queue for user input.
	// The server should return {"reply": "..."} on the next heartbeat once the user responds.
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
			// Asynchronously upload transcript for this notification
			go a.uploadAndAttach(cfg, sessionID, msgID, "notif-"+msgID+".jsonl", transcriptPath)
		}
	}

	a.mu.Lock()
	a.mode = ModeWaitingInput
	a.mu.Unlock()
}

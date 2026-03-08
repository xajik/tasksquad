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

	logger.Info(fmt.Sprintf("[%s] Starting task %s: \"%s\"", a.Config.Name, taskID, subject))

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

	// Drain stderr silently.
	go io.Copy(io.Discard, stderr)

	// Stream stdout lines to the server.
	go a.streamOutput(cfg, agentID, stdout)

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

	status := "closed"
	if code != 0 {
		status = "crashed"
	}
	a.complete(cfg, status)
}

func (a *Agent) streamOutput(cfg *config.Config, agentID string, r io.Reader) {
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
	lines := append([]string(nil), a.outputLines...)
	pw := a.stdinWrite
	a.stdinWrite = nil
	a.mu.Unlock()

	// Signal EOF to the process stdin (if still open) so it can exit cleanly.
	if pw != nil {
		pw.Close()
	}

	logger.Info(fmt.Sprintf("[%s] Completing task %s — status=%s", a.Config.Name, a.taskID, status))

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
	agentID := a.agentID
	sessionID := a.sessionID
	a.mu.Unlock()

	if mode != ModeRunning {
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

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
	"github.com/tasksquad/daemon/hooks"
	"github.com/tasksquad/daemon/logger"
)

type Mode string

const (
	ModeIdle         Mode = "idle"
	ModeRunning      Mode = "running"
	ModeWaitingInput Mode = "waiting_input"
)

type Agent struct {
	Config config.AgentConfig

	mu          sync.Mutex
	mode        Mode
	agentID     string // resolved from server on first heartbeat
	sessionID   string
	taskID      string
	outputLines []string
	completing  bool
	proc        *exec.Cmd
}

func New(cfg config.AgentConfig) *Agent {
	return &Agent{Config: cfg, mode: ModeIdle}
}

// GetMode implements the hooks.Agent interface.
func (a *Agent) GetMode() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return string(a.mode)
}

// Run is the main poll loop for this agent.
func (a *Agent) Run(cfg *config.Config) {
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

	// Resolve agentID from first heartbeat response
	if id, ok := resp["agent_id"].(string); ok && id != "" {
		a.mu.Lock()
		if a.agentID == "" {
			a.agentID = id
			logger.Info(fmt.Sprintf("[%s] Resolved agent ID: %s", a.Config.Name, id))
		}
		a.mu.Unlock()
	}

	a.mu.Lock()
	isIdle := a.mode == ModeIdle
	a.mu.Unlock()

	if task, ok := resp["task"].(map[string]any); ok && isIdle {
		logger.Info(fmt.Sprintf("[%s] Task received: %s — \"%s\"", a.Config.Name, task["id"], task["subject"]))
		go a.startTask(cfg, task)
	} else {
		logger.Debug(fmt.Sprintf("[%s] No pending tasks", a.Config.Name))
	}
}

// ── Task lifecycle ─────────────────────────────────────────────────────────────

func (a *Agent) startTask(cfg *config.Config, task map[string]any) {
	taskID, _ := task["id"].(string)
	subject, _ := task["subject"].(string)
	body, _ := task["body"].(string)

	a.mu.Lock()
	a.mode = ModeRunning
	a.taskID = taskID
	a.outputLines = nil
	a.completing = false
	a.mu.Unlock()

	logger.Info(fmt.Sprintf("[%s] Starting task %s: \"%s\"", a.Config.Name, taskID, subject))

	// Open session
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

	// Write claude-code hooks into the work directory so the CLI notifies us
	hooks.WriteHooks(a.Config.WorkDir, cfg.Hooks.Port)

	// Build prompt
	prompt := subject
	if body != "" && body != subject {
		prompt = fmt.Sprintf("%s\n\n%s", subject, body)
	}

	// Spawn the command: e.g. "claude -p <prompt>"
	parts := strings.Fields(a.Config.Command)
	args := append(parts[1:], "-p", prompt)
	cmd := exec.Command(parts[0], args...)
	cmd.Dir = a.Config.WorkDir
	cmd.Env = os.Environ()

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

	// Drain stderr silently
	go io.Copy(io.Discard, stderr)

	// Stream stdout lines to server
	go a.streamOutput(cfg, agentID, stdout)

	// Wait for process exit
	code := 0
	if err := cmd.Wait(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		}
	}
	logger.Info(fmt.Sprintf("[%s] Process exited with code %d", a.Config.Name, code))

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

// complete finalizes the current task. Safe to call multiple times (guarded by completing flag).
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
	a.mu.Unlock()

	logger.Info(fmt.Sprintf("[%s] Completing task %s — status=%s", a.Config.Name, a.taskID, status))

	all := strings.Join(lines, "\n")
	finalText := strings.TrimSpace(all)
	if len(finalText) > 10000 {
		finalText = finalText[len(finalText)-10000:]
	}

	closeResp, err := a.post(cfg, "/daemon/session/close", map[string]any{
		"session_id": sessionID,
		"status":     status,
		"final_text": finalText,
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] Session close error: %v", a.Config.Name, err))
	}

	// Push done/waiting_input SSE event to portal viewers
	if agentID != "" {
		sseType := "done"
		if status == "waiting_input" {
			sseType = "waiting_input"
		}
		a.post(cfg, "/daemon/push/"+agentID, map[string]any{ //nolint:errcheck
			"type":  sseType,
			"lines": []string{finalText},
		})
	}

	// Upload full log to R2 if server returned a presigned URL
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
	if status == "waiting_input" {
		a.mode = ModeWaitingInput
	} else {
		a.mode = ModeIdle
	}
	a.sessionID = ""
	a.outputLines = nil
	a.proc = nil
	a.completing = false
	a.mu.Unlock()
}

// Complete is called by the hook server when Claude Code emits a Stop event.
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
func (a *Agent) SetWaitingInput(cfg *config.Config, message string) {
	a.mu.Lock()
	mode := a.mode
	agentID := a.agentID
	a.mu.Unlock()

	if mode != ModeRunning {
		return
	}

	// Notify SSE clients that Claude is paused
	if agentID != "" {
		a.post(cfg, "/daemon/push/"+agentID, map[string]any{ //nolint:errcheck
			"type":  "line",
			"lines": []string{"\n[Claude is waiting for your input]\n" + message},
		})
	}

	a.complete(cfg, "waiting_input")
}

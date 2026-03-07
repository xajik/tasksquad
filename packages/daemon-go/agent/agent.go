package agent

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/hooks"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/stream"
	"github.com/tasksquad/daemon/tmux"
	"github.com/tasksquad/daemon/upload"
)

type Mode string

const (
	ModeIdle         Mode = "idle"
	ModeAccumulating Mode = "accumulating"
	ModeLive         Mode = "live"
	ModeWaitingInput Mode = "waiting_input"
)

type Agent struct {
	ID         string
	Config     config.AgentConfig
	Mode       Mode
	TaskID     string
	SessionID  string
	LogPath    string
	startedAt  time.Time
	stuckSince time.Time
	prevHash   [32]byte
	mu         sync.Mutex
	doneCh     chan struct{}
}

func New(cfg config.AgentConfig) *Agent {
	return &Agent{
		ID:     cfg.ID,
		Config: cfg,
		Mode:   ModeIdle,
	}
}

func (a *Agent) GetMode() string {
	return string(a.Mode)
}

func (a *Agent) Run(cfg *config.Config) {
	ticker := time.NewTicker(time.Duration(cfg.Server.PollInterval) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			logger.Debug(fmt.Sprintf("[%s] Tick — mode=%s", a.Config.Name, a.Mode))
			a.heartbeat(cfg)
			a.checkStuck(cfg)
			a.syncMode(cfg)
		}
	}
}

func (a *Agent) heartbeat(cfg *config.Config) {
	logger.Debug(fmt.Sprintf("[%s] Heartbeat → status=%s", a.Config.Name, a.Mode))

	resp, err := api.Post(cfg, "/daemon/heartbeat", map[string]any{
		"status": string(a.Mode),
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] Heartbeat failed: %v", a.Config.Name, err))
		return
	}

	if agentID, ok := resp["agent_id"].(string); ok && a.ID == "" {
		a.ID = agentID
		logger.Info(fmt.Sprintf("[%s] Resolved agent ID: %s", a.Config.Name, a.ID))
	}

	if task, ok := resp["task"].(map[string]any); ok && a.Mode == ModeIdle {
		logger.Debug(fmt.Sprintf("[%s] Task received: %s — \"%s\"", a.Config.Name, task["id"], task["subject"]))
		a.startTask(cfg, task)
	} else {
		logger.Debug(fmt.Sprintf("[%s] No pending tasks", a.Config.Name))
	}

	if resume, ok := resp["resume"].(map[string]any); ok && a.Mode == ModeWaitingInput {
		a.resumeTask(cfg, resume)
	}
}

func (a *Agent) startTask(cfg *config.Config, task map[string]any) {
	a.mu.Lock()
	defer a.mu.Unlock()

	taskID := task["id"].(string)
	subject := task["subject"].(string)
	body, _ := task["body"].(string)

	a.TaskID = taskID
	a.LogPath = filepath.Join(os.TempDir(), fmt.Sprintf("tsq-%s.log", a.Config.ID))
	a.startedAt = time.Now()

	sessionResp, err := api.Post(cfg, "/daemon/session/open", map[string]any{
		"task_id": taskID,
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] Session open failed: %v", a.Config.Name, err))
		return
	}
	a.SessionID = sessionResp["session_id"].(string)

	hooks.WriteHooks(a.Config.WorkDir, cfg.Hooks.Port)

	tmux.EnsureSession(a.Config.Name, a.Config.WorkDir)
	tmux.PipeToFile(a.Config.Name, a.LogPath)

	prompt := subject
	if body != "" && body != subject {
		prompt = fmt.Sprintf("%s\n\n%s", subject, body)
	}

	tmux.SendKeys(a.Config.Name, a.Config.Command+" -p \""+prompt+"\"")

	a.Mode = ModeAccumulating
	a.stuckSince = time.Now()

	logger.Info(fmt.Sprintf("[%s] Starting task %s: \"%s\"", a.Config.Name, taskID, subject))
}

func (a *Agent) resumeTask(cfg *config.Config, resume map[string]any) {
	a.mu.Lock()
	defer a.mu.Unlock()

	message := resume["message"].(string)

	tmux.PipeToFile(a.Config.Name, a.LogPath)
	tmux.SendKeys(a.Config.Name, message)
	a.Mode = ModeAccumulating
	a.stuckSince = time.Now()

	logger.Info(fmt.Sprintf("[%s] Resuming task %s with user message", a.Config.Name, a.TaskID))
}

func (a *Agent) Complete(cfg *config.Config) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.Mode == ModeIdle {
		return
	}

	logger.Info(fmt.Sprintf("[%s] Completing task %s", a.Config.Name, a.TaskID))

	tmux.StopPipe(a.Config.Name)

	if a.Mode == ModeLive && a.doneCh != nil {
		close(a.doneCh)
	}

	finalText := ""
	if data, err := os.ReadFile(a.LogPath); err == nil {
		lines := strings.Split(string(data), "\n")
		if len(lines) > 0 {
			start := 0
			if len(lines) > 2000 {
				start = len(lines) - 2000
			}
			finalText = strings.Join(lines[start:], "\n")
		}
	}

	closeResp, err := api.Post(cfg, "/daemon/session/close", map[string]any{
		"session_id": a.SessionID,
		"status":     "closed",
		"final_text": finalText,
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[%s] Session close error: %v", a.Config.Name, err))
	}

	if uploadURL, ok := closeResp["upload_url"].(string); ok && uploadURL != "" {
		upload.LogFile(uploadURL, a.LogPath)
	}

	tmux.KillSession(a.Config.Name)

	a.Mode = ModeIdle
	a.SessionID = ""
	a.TaskID = ""

	logger.Info(fmt.Sprintf("[%s] Task completed — session %s", a.Config.Name, a.SessionID))
}

func (a *Agent) SetWaitingInput(cfg *config.Config, message string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.Mode != ModeAccumulating && a.Mode != ModeLive {
		return
	}

	tmux.StopPipe(a.Config.Name)
	if a.Mode == ModeLive && a.doneCh != nil {
		close(a.doneCh)
	}

	api.Post(cfg, "/daemon/session/close", map[string]any{
		"session_id": a.SessionID,
		"status":     "waiting_input",
	})

	a.Mode = ModeWaitingInput
	logger.Info(fmt.Sprintf("[%s] Waiting for user input: %s", a.Config.Name, message))
}

func (a *Agent) checkStuck(cfg *config.Config) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.Mode == ModeIdle || a.Mode == ModeWaitingInput {
		return
	}

	output, err := tmux.CapturePane(a.Config.Name)
	if err != nil {
		return
	}

	hash := sha256.Sum256([]byte(output))
	if hash == a.prevHash {
		if time.Since(a.stuckSince) > time.Duration(cfg.StuckDetection.TimeoutSeconds)*time.Second {
			a.handleStuckUnlocked(cfg)
		}
	} else {
		a.prevHash = hash
		a.stuckSince = time.Now()
	}
}

func (a *Agent) handleStuckUnlocked(cfg *config.Config) {
	if cfg.StuckDetection.OnStuck == "auto-restart" {
		tmux.KillSession(a.Config.Name)
		task := map[string]any{
			"id":      a.TaskID,
			"subject": "",
			"body":    "",
		}
		a.startTask(cfg, task)
	} else {
		a.Mode = ModeWaitingInput
		api.Post(cfg, "/daemon/session/close", map[string]any{
			"session_id": a.SessionID,
			"status":     "waiting_input",
		})
	}
	logger.Warn(fmt.Sprintf("[%s] Agent stuck — action=%s", a.Config.Name, cfg.StuckDetection.OnStuck))
}

func (a *Agent) syncMode(cfg *config.Config) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.Mode == ModeIdle || a.Mode == ModeWaitingInput {
		return
	}

	resp, err := api.Get(cfg, fmt.Sprintf("/daemon/viewers/%s", a.ID))
	if err != nil {
		return
	}

	count, _ := resp["count"].(float64)
	viewerCount := int(count)

	if viewerCount > 0 && a.Mode == ModeAccumulating {
		a.switchToLive(cfg)
	} else if viewerCount == 0 && a.Mode == ModeLive {
		a.switchToAccumulating(cfg)
	}
}

func (a *Agent) switchToLive(cfg *config.Config) {
	if data, err := os.ReadFile(a.LogPath); err == nil && len(data) > 0 {
		lines := strings.Split(string(data), "\n")
		api.Post(cfg, fmt.Sprintf("/daemon/push/%s", a.ID), map[string]any{
			"type":  "backlog",
			"lines": lines,
		})
	}

	tmux.StopPipe(a.Config.Name)
	a.Mode = ModeLive
	a.doneCh = make(chan struct{})
	go stream.Run(cfg, a.ID, a.Config.Name, a.doneCh)
}

func (a *Agent) switchToAccumulating(cfg *config.Config) {
	if a.doneCh != nil {
		close(a.doneCh)
	}
	tmux.PipeToFile(a.Config.Name, a.LogPath)
	a.Mode = ModeAccumulating
}

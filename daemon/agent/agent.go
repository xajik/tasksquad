package agent

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/tasksquad/daemon/config"
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
	ID     string
	Config config.AgentConfig

	mu         sync.Mutex
	Mode       Mode
	TaskID     string
	SessionID  string
	LogPath    string
	startedAt  time.Time
	prevHash   [32]byte
	stuckSince time.Time
	doneCh     chan struct{}
}

func New(id string, cfg config.AgentConfig) *Agent {
	return &Agent{ID: id, Config: cfg, Mode: ModeIdle}
}

func (a *Agent) Run(cfg *config.Config) {
	ticker := time.NewTicker(time.Duration(cfg.Server.PollInterval) * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		a.heartbeat(cfg)
		a.checkStuck(cfg)
		a.syncMode(cfg)
	}
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

func (a *Agent) heartbeat(cfg *config.Config) {
	resp := apiPost(cfg, "/daemon/heartbeat", map[string]any{
		"agent_id": a.ID,
		"team_id":  cfg.Server.TeamID,
		"status":   string(a.Mode),
	})
	if task, ok := resp["task"]; ok {
		a.mu.Lock()
		idle := a.Mode == ModeIdle
		a.mu.Unlock()
		if idle {
			a.startTask(cfg, task.(map[string]any))
		}
	}
	if resume, ok := resp["resume"]; ok {
		a.mu.Lock()
		waiting := a.Mode == ModeWaitingInput
		a.mu.Unlock()
		if waiting {
			a.resumeTask(cfg, resume.(map[string]any))
		}
	}
}

// ── Task lifecycle ─────────────────────────────────────────────────────────────

func (a *Agent) startTask(cfg *config.Config, task map[string]any) {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.TaskID = task["id"].(string)
	a.LogPath = filepath.Join(os.TempDir(), "tsq-"+a.ID+".log")
	a.startedAt = time.Now()
	a.stuckSince = time.Now()

	sessResp := apiPost(cfg, "/daemon/session/open", map[string]any{
		"task_id":  a.TaskID,
		"agent_id": a.ID,
	})
	if sid, ok := sessResp["session_id"].(string); ok {
		a.SessionID = sid
	}

	tmux.EnsureSession(a.Config.Name, a.Config.WorkDir)
	tmux.PipeToFile(a.Config.Name, a.LogPath)

	subject, _ := task["subject"].(string)
	body, _ := task["body"].(string)
	prompt := fmt.Sprintf("%s\n\nTask ID: %s\n%s", subject, a.TaskID, body)
	tmux.SendKeys(a.Config.Name, prompt)

	a.Mode = ModeAccumulating
}

func (a *Agent) resumeTask(cfg *config.Config, resume map[string]any) {
	a.mu.Lock()
	defer a.mu.Unlock()

	tmux.PipeToFile(a.Config.Name, a.LogPath)
	if msg, ok := resume["message"].(string); ok {
		tmux.SendKeys(a.Config.Name, msg)
	}
	a.Mode = ModeAccumulating
	a.stuckSince = time.Now()
}

// Complete is called by the hook server when Claude Code stops.
func (a *Agent) Complete(cfg *config.Config) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.Mode == ModeIdle {
		return
	}

	if a.doneCh != nil {
		close(a.doneCh)
		a.doneCh = nil
	}
	tmux.StopPipe(a.Config.Name)

	finalText := upload.ExtractFinalText(a.LogPath)

	closeResp := apiPost(cfg, "/daemon/session/close", map[string]any{
		"session_id": a.SessionID,
		"status":     "closed",
		"final_text": finalText,
	})

	if uploadURL, ok := closeResp["upload_url"].(string); ok && uploadURL != "" {
		upload.UploadLog(uploadURL, a.LogPath)
		r2Key, _ := closeResp["key"].(string)
		apiPost(cfg, "/daemon/complete", map[string]any{
			"task_id":     a.TaskID,
			"session_id":  a.SessionID,
			"agent_id":    a.ID,
			"final_text":  finalText,
			"r2_log_key":  r2Key,
			"duration_ms": time.Since(a.startedAt).Milliseconds(),
			"success":     true,
		})
	}

	tmux.KillSession(a.Config.Name)
	a.Mode = ModeIdle
	a.TaskID = ""
	a.SessionID = ""
}

// SetWaitingInput is called by the hook server on a Notification event.
func (a *Agent) SetWaitingInput(cfg *config.Config, message string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.doneCh != nil {
		close(a.doneCh)
		a.doneCh = nil
	}
	tmux.StopPipe(a.Config.Name)
	a.Mode = ModeWaitingInput

	apiPost(cfg, "/daemon/session/close", map[string]any{
		"session_id": a.SessionID,
		"status":     "waiting_input",
		"final_text": message,
	})
}

// ── Mode switching ─────────────────────────────────────────────────────────────

func (a *Agent) syncMode(cfg *config.Config) {
	a.mu.Lock()
	m := a.Mode
	a.mu.Unlock()

	if m == ModeIdle || m == ModeWaitingInput {
		return
	}

	resp := apiGet(cfg, "/daemon/viewers/"+a.ID)
	count := 0
	if c, ok := resp["count"].(float64); ok {
		count = int(c)
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	switch {
	case count > 0 && a.Mode == ModeAccumulating:
		a.switchToLive(cfg)
	case count == 0 && a.Mode == ModeLive:
		a.switchToAccumulating(cfg)
	}
}

func (a *Agent) switchToLive(cfg *config.Config) {
	if data, err := os.ReadFile(a.LogPath); err == nil && len(data) > 0 {
		lines := splitLines(string(data))
		apiPost(cfg, "/daemon/push/"+a.ID, map[string]any{"type": "backlog", "lines": lines})
	}
	tmux.StopPipe(a.Config.Name)
	a.Mode = ModeLive
	a.doneCh = make(chan struct{})
	go stream.Run(cfg, a.ID, a.Config.Name, a.doneCh)
}

func (a *Agent) switchToAccumulating(cfg *config.Config) {
	if a.doneCh != nil {
		close(a.doneCh)
		a.doneCh = nil
	}
	tmux.PipeToFile(a.Config.Name, a.LogPath)
	a.Mode = ModeAccumulating
}

// ── Stuck detection ───────────────────────────────────────────────────────────

func (a *Agent) checkStuck(cfg *config.Config) {
	a.mu.Lock()
	m := a.Mode
	a.mu.Unlock()

	if m == ModeIdle || m == ModeWaitingInput {
		return
	}

	output := tmux.CapturePane(a.Config.Name)
	hash := sha256.Sum256([]byte(output))

	a.mu.Lock()
	defer a.mu.Unlock()

	if hash == a.prevHash {
		timeout := time.Duration(cfg.StuckDetection.TimeoutSeconds) * time.Second
		if time.Since(a.stuckSince) > timeout {
			a.handleStuck(cfg)
		}
	} else {
		a.prevHash = hash
		a.stuckSince = time.Now()
	}
}

func (a *Agent) handleStuck(cfg *config.Config) {
	switch cfg.StuckDetection.OnStuck {
	case "auto-restart":
		tmux.KillSession(a.Config.Name)
		task := map[string]any{"id": a.TaskID, "subject": "", "body": ""}
		a.Mode = ModeIdle
		go a.startTask(cfg, task)
	default: // "notify"
		a.Mode = ModeWaitingInput
	}
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

func apiPost(cfg *config.Config, path string, body map[string]any) map[string]any {
	data, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, cfg.Server.URL+path, bytes.NewReader(data))
	if err != nil {
		return nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-TSQ-Token", cfg.Server.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var result map[string]any
	b, _ := io.ReadAll(resp.Body)
	json.Unmarshal(b, &result)
	return result
}

func apiGet(cfg *config.Config, path string) map[string]any {
	req, err := http.NewRequest(http.MethodGet, cfg.Server.URL+path, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("X-TSQ-Token", cfg.Server.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var result map[string]any
	b, _ := io.ReadAll(resp.Body)
	json.Unmarshal(b, &result)
	return result
}

func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	return splitByNewline(s)
}

func splitByNewline(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

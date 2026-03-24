package supervisor

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/tmux"
)

const inactivityTimeout = 10 * time.Minute
const checkInterval = 60 * time.Second

// MonitoredAgent is the interface the supervisor requires from each agent.
type MonitoredAgent interface {
	Name() string
	AgentID() string
	GetMode() string
	GetTaskID() string
	TmuxSession() string
	WorkDir() string
	LastLogPath() string
	GetLastActivityAt() time.Time
}

// Supervisor monitors all agents and spawns a dedicated tmux session when a
// running task has had no hook activity for inactivityTimeout.
type Supervisor struct {
	mu            sync.Mutex
	activeForTask map[string]bool
	cli           string // resolved CLI binary path
	cfg           *config.Config
}

// New creates a Supervisor and detects the CLI tool from config or PATH priority.
func New(cfg *config.Config) *Supervisor {
	return &Supervisor{
		activeForTask: make(map[string]bool),
		cli:           detectCLI(cfg),
		cfg:           cfg,
	}
}

// detectCLI returns the CLI binary to use for supervisor sessions.
// Prefers an agent with is_supervisor=true; falls back to PATH priority.
func detectCLI(cfg *config.Config) string {
	for _, a := range cfg.Agents {
		if a.IsSupervisor {
			parts := strings.Fields(a.Command)
			if len(parts) > 0 {
				if p, err := exec.LookPath(parts[0]); err == nil {
					logger.Info(fmt.Sprintf("[supervisor] Using designated supervisor command: %s", parts[0]))
					return p
				}
			}
		}
	}
	for _, cmd := range []string{"claude", "gemini", "opencode", "codex"} {
		if p, err := exec.LookPath(cmd); err == nil {
			logger.Info(fmt.Sprintf("[supervisor] Auto-detected CLI: %s", p))
			return p
		}
	}
	logger.Warn("[supervisor] No CLI tool found — supervisor disabled")
	return ""
}

// Monitor watches agents in a loop and spawns supervisor sessions for inactive tasks.
// Blocks forever; run in a goroutine.
func (s *Supervisor) Monitor(agents []MonitoredAgent) {
	if s.cli == "" {
		logger.Warn("[supervisor] No CLI available — monitor not started")
		return
	}
	logger.Info(fmt.Sprintf("[supervisor] Monitor started (cli=%s, timeout=%s)", s.cli, inactivityTimeout))

	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	for range ticker.C {
		for _, a := range agents {
			if a.GetMode() != "running" {
				continue
			}
			taskID := a.GetTaskID()
			if taskID == "" {
				continue
			}
			s.mu.Lock()
			active := s.activeForTask[taskID]
			s.mu.Unlock()
			if active {
				continue
			}
			lastActivity := a.GetLastActivityAt()
			if lastActivity.IsZero() || time.Since(lastActivity) < inactivityTimeout {
				continue
			}
			logger.Info(fmt.Sprintf("[supervisor] Agent %q task %s inactive >%s — spawning supervisor",
				a.Name(), taskID, inactivityTimeout))
			s.mu.Lock()
			s.activeForTask[taskID] = true
			s.mu.Unlock()
			go s.spawn(a, taskID)
		}
	}
}

// spawn starts a supervisor tmux session for the given stuck task.
func (s *Supervisor) spawn(a MonitoredAgent, taskID string) {
	defer func() {
		s.mu.Lock()
		delete(s.activeForTask, taskID)
		s.mu.Unlock()
	}()

	suffix := taskID
	if len(suffix) > 8 {
		suffix = suffix[:8]
	}
	sessionName := "tsq-sup-" + suffix
	workDir := a.WorkDir()
	agentTmux := a.TmuxSession()
	agentID := a.AgentID()
	logPath := a.LastLogPath()
	troubleshootPath := troubleshootingFile(workDir)
	supLog := SupervisorLogPath(taskID)

	// Ensure supervisor log directory exists.
	if err := os.MkdirAll(filepath.Dir(supLog), 0755); err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Failed to create log dir: %v", err))
		return
	}

	tmuxSnapshot := captureTmuxPane(agentTmux, 50)
	prompt := buildPrompt(a.Name(), taskID, agentTmux, logPath, troubleshootPath, tmuxSnapshot)

	// Write header + prompt to log file before the session starts.
	header := fmt.Sprintf(
		"# TaskSquad Supervisor Log\n# agent=%s  task_id=%s\n# started=%s\n\n--- PROMPT ---\n%s\n\n--- OUTPUT ---\n",
		a.Name(), taskID, time.Now().Format(time.RFC3339), prompt,
	)
	os.WriteFile(supLog, []byte(header), 0644) //nolint:errcheck

	// Launch detached tmux session running the CLI tool interactively.
	// Output is piped to the log via `script` so it is captured without -p flag.
	shellCmd := fmt.Sprintf(`script -q -a %s %s`, supLog, s.cli)
	err := exec.Command("tmux", "new-session", "-d", "-s", sessionName,
		"-c", workDir, "sh", "-c", shellCmd).Run()
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Failed to start tmux session %s: %v", sessionName, err))
		return
	}
	logger.Info(fmt.Sprintf("[supervisor] Session %s started for task %s — attach: tmux attach-session -t %s",
		sessionName, taskID, sessionName))

	// Write prompt to a temp file — used for paste-buffer and kept for the log.
	promptFile := fmt.Sprintf("/tmp/tsq-sup-%s.prompt", suffix)
	if err := os.WriteFile(promptFile, []byte(prompt), 0600); err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Failed to write prompt file: %v", err))
		return
	}

	// Wait for the CLI to fully initialise before sending the prompt.
	tmux.WaitForReady()

	// Load prompt into a named tmux buffer, paste it into the session
	// (avoids shell-quoting issues with multi-line text), then send Enter.
	bufName := "sup-" + suffix
	tmux.PastePromptFile(sessionName, bufName, promptFile) //nolint:errcheck

	// Block until the session exits.
	waitForSession(sessionName)

	// Clean up temp files.
	os.Remove(promptFile) //nolint:errcheck
	tmux.DeleteBuffer(bufName)

	// Append completion marker to log.
	appendToLog(supLog, fmt.Sprintf("\n--- SUPERVISOR COMPLETE: %s ---\n", time.Now().Format(time.RFC3339)))
	logger.Info(fmt.Sprintf("[supervisor] Session %s complete for task %s", sessionName, taskID))

	// Parse supervisor output and route based on status.
	report, status := parseSupervisorOutput(supLog)
	if report != "" && status != "" {
		if status == "healthy" {
			// Task is running well - send minimal progress message (no push)
			go s.notifyProgress(taskID, agentID, "Task is running well — picked up and in progress")
		} else {
			// Stuck/resolved/failed - send full report to inbox
			go s.reportToWorker(taskID, agentID, report)
		}
	}
}

// captureTmuxPane returns the last n lines of a tmux pane's scrollback.
// Returns an empty string if the session does not exist or tmux is unavailable.
func captureTmuxPane(session string, lines int) string {
	if session == "" {
		return ""
	}
	return tmux.CapturePane(session, lines)
}

// buildPrompt returns the initial message sent to the supervisor CLI.
func buildPrompt(agentName, taskID, tmuxSession, logPath, troubleshootingPath, tmuxSnapshot string) string {
	// Session availability determines which commands are possible.
	sessionID := "(none — session may have crashed)"
	attachCmd := "# no session to attach to"
	captureCmd := "# no session to capture"
	scrollbackCmd := "# no session to capture"
	sendKeyCmd := "# no session to send keys to"
	if tmuxSession != "" {
		sessionID = tmuxSession
		attachCmd = fmt.Sprintf("tmux attach-session -t %s", tmuxSession)
		captureCmd = fmt.Sprintf("tmux capture-pane -t %s -p", tmuxSession)
		scrollbackCmd = fmt.Sprintf("tmux capture-pane -t %s -p -S -200", tmuxSession)
		sendKeyCmd = fmt.Sprintf("tmux send-keys -t %s \"<text>\"\nsleep 2\ntmux send-keys -t %s C-m", tmuxSession, tmuxSession)
	}

	logSection := "(no run log available)"
	if logPath != "" {
		logSection = logPath
	}

	snapshotSection := "(session not available)"
	if tmuxSnapshot != "" {
		snapshotSection = tmuxSnapshot
	}

	return fmt.Sprintf(
		`You are a TaskSquad Supervisor. The agent below has been in "running" state for
over 10 minutes with no activity. Perform a health check and unblock it if needed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Agent:        %q
Task ID:      %s
tmux session: %s
Run log:      %s
Past fixes:   %s

Terminal snapshot (last 50 lines captured at supervisor start):
────────────────────────────────────────────────────────
%s
────────────────────────────────────────────────────────

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — INSPECT  (always run these first)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1a. Confirm session exists and see all active tsq sessions:
tsq sessions
tmux list-sessions

# 1b. Read the current visible terminal state (plain text):
%s

# 1b-alt. If the TUI is hard to read as text, capture with ANSI colours preserved
#         and save to a file you can inspect — or take a macOS screenshot:
#   tmux capture-pane -t %s -p -e > /tmp/tsq-sup-capture.txt && cat /tmp/tsq-sup-capture.txt
#   screencapture -x /tmp/tsq-sup-screen.png   # macOS: saves a PNG you can View

# 1c. Read the last 200 lines of scrollback for full context:
%s

# 1d. Read the run log for errors or last known state:
cat "%s"

# 1e. Check past fixes for this project:
cat "%s"

# To attach interactively (FYI — only if you need it):
%s

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — DECIDE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After reading the terminal output, choose ONE of the following paths:

PATH A — Agent is BLOCKED by a non-standard prompt
  Trigger: any interactive prompt that requires a keypress to continue.
  Examples and the exact keys to send:

  y/n confirmation  ("Do you want to proceed?", "Allow?", "Continue? [y/N]"):
    %s

  Numbered menu  ("1. Option A  2. Option B  …"):
    tmux send-keys -t %s "1"
    sleep 2
    tmux send-keys -t %s C-m

  Arrow-key / Enter menu  (highlighted selection, press C-m to confirm):
    tmux send-keys -t %s C-m               # just Enter — no content to type first

  Checkbox  (spacebar toggles, C-m confirms):
    tmux send-keys -t %s " "
    sleep 2
    tmux send-keys -t %s C-m

  Permission / tool approval  ("Allow claude to run bash?", "Approve?"):
    tmux send-keys -t %s "y"
    sleep 2
    tmux send-keys -t %s C-m

  Empty-input confirm  (blank prompt "> " or just waiting for C-m):
    tmux send-keys -t %s C-m               # just Enter — no content to type first

  After sending: wait 5 seconds, then re-run Step 1b to confirm the agent resumed.

PATH B — Agent is HEALTHY (output still progressing / just slow)
  Symptoms: recent scrollback lines differ from older ones, files being read/written.
  Action: do nothing. Skip to Step 3.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — RECORD (only if you learned something new)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If you encountered an issue not already in the past-fixes file, append it:
  File: %s
  Format:
    ## <ISO date> — <short issue title>
    Agent: %q  Task: %s
    Issue: <what was blocking it>
    Fix: <what you sent or did>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4 — REPORT  (always last — this is your final output)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When you are done with your investigation, output EXACTLY this marker line FIRST,
then a JSON block. Nothing else should come after this block:

Supervisor verdict is:
{
  "status": "healthy|resolved|failed",
  "summary": "<one-line summary>",
  "found": "<what the terminal showed — one sentence>",
  "action": "<what you sent, or 'none'>"
}

The status must be exactly: "healthy" (agent is running fine), "resolved" (you fixed the issue), or "failed" (agent is stuck and cannot be unblocked).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ Always run Step 1 before deciding
  ✓ Only act if the agent is genuinely blocked by a prompt (PATH A)
  ✓ Send keys in TWO steps: first send text, wait 2s, then send C-m separately
  ✗ Never kill the agent session
  ✗ Never restart a task
  ✗ Never send keys if the agent is actively progressing`,
		agentName, taskID, sessionID, logSection, troubleshootingPath, snapshotSection,
		captureCmd, tmuxSession, scrollbackCmd, logSection, troubleshootingPath, attachCmd,
		sendKeyCmd,
		tmuxSession, tmuxSession, tmuxSession, tmuxSession, tmuxSession, tmuxSession, tmuxSession, tmuxSession,
		troubleshootingPath, agentName, taskID,
	)
}

// SupervisorLogPath returns the per-task supervisor log path.
// Format: ~/.tasksquad/logs/supervisor/<taskID>.log
func SupervisorLogPath(taskID string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".tasksquad", "logs", "supervisor", taskID+".log")
}

// troubleshootingFile returns the per-project troubleshooting notes path.
// Format: ~/.tasksquad/projects/<project>/troubleshooting.md
func troubleshootingFile(workDir string) string {
	home, _ := os.UserHomeDir()
	project := sanitize(filepath.Base(workDir))
	if project == "" || project == "." {
		project = "default"
	}
	dir := filepath.Join(home, ".tasksquad", "projects", project)
	os.MkdirAll(dir, 0755) //nolint:errcheck
	return filepath.Join(dir, "troubleshooting.md")
}

// waitForSession blocks until the named tmux session no longer exists.
func waitForSession(name string) {
	for {
		time.Sleep(15 * time.Second)
		if !tmux.HasSession(name) {
			return
		}
	}
}

// appendToLog appends text to a file, ignoring errors.
func appendToLog(path, text string) {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprint(f, text) //nolint:errcheck
}

// supervisorVerdict represents the JSON output from the supervisor CLI.
type supervisorVerdict struct {
	Status  string `json:"status"`
	Summary string `json:"summary"`
	Found   string `json:"found"`
	Action  string `json:"action"`
}

// parseSupervisorOutput reads the supervisor log and extracts the verdict.
// Returns the report body and the status ("healthy", "resolved", "crashed", or "" if not found).
func parseSupervisorOutput(logPath string) (string, string) {
	f, err := os.Open(logPath)
	if err != nil {
		return "", ""
	}
	defer f.Close()

	// Scan for the --- OUTPUT --- separator, then collect lines until
	// --- SUPERVISOR COMPLETE: is hit.
	inOutput := false
	var outputLines []string

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "--- OUTPUT ---") {
			inOutput = true
			continue
		}
		if strings.HasPrefix(line, "--- SUPERVISOR COMPLETE:") {
			break
		}
		if inOutput {
			outputLines = append(outputLines, line)
		}
	}

	// Find the "Supervisor verdict is:" marker
	verdictStart := -1
	for i, line := range outputLines {
		if strings.Contains(line, "Supervisor verdict is:") {
			verdictStart = i
			break
		}
	}
	if verdictStart < 0 {
		return "", ""
	}

	// Extract lines after the verdict marker
	verdictLines := outputLines[verdictStart+1:]
	verdictText := strings.TrimSpace(strings.Join(verdictLines, "\n"))

	// Try to parse as JSON first
	var verdict supervisorVerdict
	if err := json.Unmarshal([]byte(verdictText), &verdict); err == nil {
		if verdict.Status == "healthy" || verdict.Status == "resolved" || verdict.Status == "failed" {
			// Format as readable report
			report := fmt.Sprintf("[Supervisor] %s\nStatus: %s\nFound: %s\nAction: %s",
				verdict.Summary, verdict.Status, verdict.Found, verdict.Action)
			return report, verdict.Status
		}
	}

	// Fallback to regex parsing
	statusRE := regexp.MustCompile(`(?i)"status"\s*:\s*"([^"]+)"`)
	summaryRE := regexp.MustCompile(`(?i)"summary"\s*:\s*"([^"]+)"`)
	foundRE := regexp.MustCompile(`(?i)"found"\s*:\s*"([^"]+)"`)
	actionRE := regexp.MustCompile(`(?i)"action"\s*:\s*"([^"]+)"`)

	status := ""
	summary := ""
	found := ""
	action := ""

	if matches := statusRE.FindStringSubmatch(verdictText); len(matches) > 1 {
		status = matches[1]
	}
	if matches := summaryRE.FindStringSubmatch(verdictText); len(matches) > 1 {
		summary = matches[1]
	}
	if matches := foundRE.FindStringSubmatch(verdictText); len(matches) > 1 {
		found = matches[1]
	}
	if matches := actionRE.FindStringSubmatch(verdictText); len(matches) > 1 {
		action = matches[1]
	}

	// Validate status
	if status != "healthy" && status != "resolved" && status != "failed" {
		return "", ""
	}

	report := fmt.Sprintf("[Supervisor] %s\nStatus: %s\nFound: %s\nAction: %s",
		summary, status, found, action)
	return report, status
}

// reportToWorker posts a supervisor message to the task inbox via the daemon API.
func (s *Supervisor) reportToWorker(taskID, agentID, body string) {
	if s.cfg == nil {
		return
	}
	token, err := auth.GetToken(s.cfg.Firebase.APIKey, s.cfg.Server.URL)
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Auth failed for report (task %s): %v", taskID, err))
		return
	}
	_, err = api.Post(s.cfg, token, agentID, "/daemon/supervisor/report", map[string]any{
		"task_id": taskID,
		"body":    body,
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Failed to post report for task %s: %v", taskID, err))
		return
	}
	logger.Info(fmt.Sprintf("[supervisor] Report posted for task %s (%d chars)", taskID, len(body)))
}

// notifyProgress posts a minimal "running well" progress message to the task inbox.
// Uses type="progress" to indicate this is just a status update, not a full report.
func (s *Supervisor) notifyProgress(taskID, agentID, message string) {
	if s.cfg == nil {
		return
	}
	token, err := auth.GetToken(s.cfg.Firebase.APIKey, s.cfg.Server.URL)
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Auth failed for progress (task %s): %v", taskID, err))
		return
	}
	_, err = api.Post(s.cfg, token, agentID, "/daemon/supervisor/report", map[string]any{
		"task_id": taskID,
		"body":    "[Supervisor] " + message,
		"type":    "progress",
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Failed to post progress for task %s: %v", taskID, err))
		return
	}
	logger.Info(fmt.Sprintf("[supervisor] Progress posted for task %s", taskID))
}

// sanitize replaces non-alphanumeric characters with hyphens.
func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	return b.String()
}

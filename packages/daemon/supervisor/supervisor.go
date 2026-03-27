package supervisor

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/tmux"
	"github.com/tasksquad/daemon/util"
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
const (
	// supervisorTimeout is how long a supervisor session may run before it is
	// killed and the attempt is retried on the next inactivity cycle.
	supervisorTimeout = 5 * time.Minute

	// orphanCleanupInterval is how often the supervisor scans for dangling
	// tsq-sup-* tmux sessions that survived previous daemon runs or crashes.
	orphanCleanupInterval = 12 * time.Hour

	// sessionCheckInterval is how often waitForVerdictOrKill polls whether the
	// supervisor tmux session is still alive (print-mode self-termination).
	sessionCheckInterval = 5 * time.Second
)

// supervisorVerdict is the payload sent by the supervisor agent via POST /hooks/supervisor.
type supervisorVerdict struct {
	Status  string `json:"status"`
	Summary string `json:"summary"`
	Found   string `json:"found"`
	Action  string `json:"action"`
}

// maxSupervisorFailures is the number of consecutive no-verdict attempts before
// the supervisor sends an escalation message to the task thread.
const maxSupervisorFailures = 5

type Supervisor struct {
	mu            sync.Mutex
	activeForTask map[string]bool
	lastAttempt   map[string]time.Time            // when supervision was last attempted per taskID
	failCount     map[string]int                  // consecutive no-verdict attempts per taskID
	verdictChans  map[string]chan supervisorVerdict // taskID → verdict delivery channel
	cli           string                           // resolved CLI binary path
	daemonBinDir  string                           // directory containing the tsq binary; prepended to PATH in supervisor sessions
	cfg           *config.Config
}

// New creates a Supervisor and detects the CLI tool from config or PATH priority.
func New(cfg *config.Config) *Supervisor {
	binDir := ""
	if exe, err := os.Executable(); err == nil {
		binDir = filepath.Dir(exe)
	}
	return &Supervisor{
		activeForTask: make(map[string]bool),
		lastAttempt:   make(map[string]time.Time),
		failCount:     make(map[string]int),
		verdictChans:  make(map[string]chan supervisorVerdict),
		cli:           detectCLI(cfg),
		daemonBinDir:  binDir,
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

// HandleVerdict receives a supervisor verdict from POST /hooks/supervisor and
// delivers it to the waiting spawn() goroutine via its channel.
// Holds the mutex for the full operation to avoid a TOCTOU race between
// checking the channel exists and sending on it.
func (s *Supervisor) HandleVerdict(taskID, status, summary, found, action string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch, ok := s.verdictChans[taskID]
	if !ok {
		logger.Warn(fmt.Sprintf("[supervisor] HandleVerdict: no active session for task %s (already done or unknown)", taskID))
		return
	}
	select {
	case ch <- supervisorVerdict{Status: status, Summary: summary, Found: found, Action: action}:
		logger.Info(fmt.Sprintf("[supervisor] Verdict received for task %s: status=%s", taskID, status))
	default:
		logger.Warn(fmt.Sprintf("[supervisor] HandleVerdict: duplicate verdict for task %s — ignoring", taskID))
	}
}

// CancelForTask kills any active supervisor session for the given task.
// Called when the monitored agent's Stop hook fires (task is completing normally).
func (s *Supervisor) CancelForTask(taskID string) {
	if taskID == "" {
		return
	}
	suffix := taskID
	if len(suffix) > 8 {
		suffix = suffix[:8]
	}
	sessionName := "tsq-sup-" + suffix
	if tmux.HasSession(sessionName) {
		logKill(sessionName, tmux.KillSession(sessionName))
		logger.Info(fmt.Sprintf("[supervisor] CancelForTask: killed %s (agent stop received for task %s)", sessionName, taskID))
	}
	s.mu.Lock()
	delete(s.activeForTask, taskID)
	delete(s.failCount, taskID)
	s.mu.Unlock()
}

// Monitor watches agents in a loop and spawns supervisor sessions for inactive tasks.
// Blocks forever; run in a goroutine.
func (s *Supervisor) Monitor(agents []MonitoredAgent) {
	if s.cli == "" {
		logger.Warn("[supervisor] No CLI available — monitor not started")
		return
	}
	logger.Info(fmt.Sprintf("[supervisor] Monitor started (cli=%s, timeout=%s)", s.cli, inactivityTimeout))

	// Kill any tsq-sup-* sessions left over from a previous daemon run.
	s.cleanOrphans()

	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()
	orphanTicker := time.NewTicker(orphanCleanupInterval)
	defer orphanTicker.Stop()

	for {
		select {
		case <-ticker.C:
			for _, a := range agents {
				if a.GetMode() != "running" {
					continue
				}
				taskID := a.GetTaskID()
				if taskID == "" {
					continue
				}
				// Only supervise agents running via tmux; stdout-pipe providers
				// (e.g. codex) have no session to inspect or send keys to.
				if a.TmuxSession() == "" {
					continue
				}
				s.mu.Lock()
				active := s.activeForTask[taskID]
				last := s.lastAttempt[taskID]
				s.mu.Unlock()
				if active {
					continue
				}
				// Cooldown: don't re-attempt until inactivityTimeout after the last attempt.
				if !last.IsZero() && time.Since(last) < inactivityTimeout {
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
				s.lastAttempt[taskID] = time.Now()
				s.mu.Unlock()
				go s.spawn(a, taskID)
			}
		case <-orphanTicker.C:
			s.cleanOrphans()
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
	contextBlock := buildContextBlock(a.Name(), taskID, agentTmux, logPath, troubleshootPath, tmuxSnapshot)

	// Write header + context to log file before the session starts.
	header := fmt.Sprintf(
		"# TaskSquad Supervisor Log\n# agent=%s  task_id=%s\n# started=%s\n\n--- CONTEXT ---\n%s\n\n--- OUTPUT ---\n",
		a.Name(), taskID, time.Now().Format(time.RFC3339), contextBlock,
	)
	os.WriteFile(supLog, []byte(header), 0644) //nolint:errcheck

	// Write context block to a secure temp file before launching the session.
	// Use os.CreateTemp so the OS picks a non-predictable path.
	tmpF, err := os.CreateTemp("", "tsq-sup-*.prompt")
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Failed to create temp prompt file: %v", err))
		return
	}
	promptFile := tmpF.Name()
	if _, err := tmpF.WriteString(contextBlock); err != nil {
		tmpF.Close()
		os.Remove(promptFile) //nolint:errcheck
		logger.Error(fmt.Sprintf("[supervisor] Failed to write prompt file: %v", err))
		return
	}
	tmpF.Close()

	// Launch detached tmux session running the CLI in print/non-interactive mode.
	// Print mode (-p) outputs clean text (no ANSI codes) and self-terminates.
	// --dangerouslySkipPermissions pre-approves tool calls (tmux, curl) without blocking.
	shellCmd := printModeCmd(s.cli, promptFile, supLog, s.daemonBinDir, taskID, s.cfg.Hooks.Port)
	err = exec.Command("tmux", "new-session", "-d", "-s", sessionName,
		"-c", workDir, "sh", "-c", shellCmd).Run()
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Failed to start tmux session %s: %v", sessionName, err))
		return
	}
	logger.Info(fmt.Sprintf("[supervisor] Session %s started for task %s — attach: tmux attach-session -t %s",
		sessionName, taskID, sessionName))

	// Wait for the supervisor to POST /hooks/supervisor or for timeout/session-death.
	verdict, verdictFound := s.waitForVerdictOrKill(taskID, sessionName)

	// Clean up temp file.
	os.Remove(promptFile) //nolint:errcheck

	if !verdictFound {
		appendToLog(supLog, fmt.Sprintf("\n--- SUPERVISOR TIMEOUT/EXIT: %s ---\n", time.Now().Format(time.RFC3339)))
		s.mu.Lock()
		s.failCount[taskID]++
		count := s.failCount[taskID]
		s.mu.Unlock()
		logger.Warn(fmt.Sprintf("[supervisor] Session %s ended without verdict (attempt %d/%d)", sessionName, count, maxSupervisorFailures))
		if count >= maxSupervisorFailures {
			s.mu.Lock()
			s.failCount[taskID] = 0
			s.mu.Unlock()
			logger.Error(fmt.Sprintf("[supervisor] Task %s: %d consecutive failures — escalating", taskID, count))
			go s.escalate(taskID, agentID, count)
		}
		return
	}

	appendToLog(supLog, fmt.Sprintf("\n--- SUPERVISOR COMPLETE: %s ---\n", time.Now().Format(time.RFC3339)))
	s.mu.Lock()
	s.failCount[taskID] = 0
	s.mu.Unlock()
	logger.Info(fmt.Sprintf("[supervisor] Session %s complete for task %s (status=%s)", sessionName, taskID, verdict.Status))

	report := fmt.Sprintf("[Supervisor] %s\nStatus: %s\nFound: %s\nAction: %s",
		verdict.Summary, verdict.Status, verdict.Found, verdict.Action)

	if verdict.Status == "working_fine" {
		go s.notifyProgress(taskID, agentID, "Task is running well — picked up and in progress")
	} else {
		go s.reportToWorker(taskID, agentID, report)
	}
}

// waitForVerdictOrKill waits for the supervisor agent to POST /hooks/supervisor
// (delivered via HandleVerdict), the session to die naturally, or the timeout.
// Returns the verdict and whether one was received.
func (s *Supervisor) waitForVerdictOrKill(taskID, sessionName string) (supervisorVerdict, bool) {
	ch := make(chan supervisorVerdict, 1)
	s.mu.Lock()
	s.verdictChans[taskID] = ch
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.verdictChans, taskID)
		s.mu.Unlock()
	}()

	deadline := time.NewTimer(supervisorTimeout)
	defer deadline.Stop()
	checkTicker := time.NewTicker(sessionCheckInterval)
	defer checkTicker.Stop()

	for {
		select {
		case v := <-ch:
			// Verdict delivered via /hooks/supervisor — kill session and return.
			time.Sleep(500 * time.Millisecond) // let output flush
			logKill(sessionName, tmux.KillSession(sessionName))
			return v, true

		case <-deadline.C:
			logKill(sessionName, tmux.KillSession(sessionName))
			logger.Warn(fmt.Sprintf("[supervisor] Session %s timed out after %s", sessionName, supervisorTimeout))
			return supervisorVerdict{}, false

		case <-checkTicker.C:
			// Print mode: CLI process exits when done, killing the tmux session.
			if !tmux.HasSession(sessionName) {
				logger.Warn(fmt.Sprintf("[supervisor] Session %s: process exited without calling /hooks/supervisor", sessionName))
				return supervisorVerdict{}, false
			}
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

// buildContextBlock returns the short initial message sent to the supervisor CLI.
// It provides dynamic context only; all methodology is in the /tsq-supervisor skill.
func buildContextBlock(agentName, taskID, tmuxSession, logPath, troubleshootingPath, tmuxSnapshot string) string {
	sessionID := "(none — session may have crashed)"
	if tmuxSession != "" {
		sessionID = tmuxSession
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
		`You are a TaskSquad Supervisor. The agent below has been in "running" state for over 10 minutes with no activity.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Agent:        %q
Task ID:      %s
tmux session: %s
Run log:      %s
Past fixes:   %s
Hooks port:   7374

Terminal snapshot (last 50 lines captured at supervisor start):
────────────────────────────────────────────────────────
%s
────────────────────────────────────────────────────────

Known blocking patterns (check these first):
- Gemini rate limit: "Usage limit reached for <model>. Access resets at HH:MM"
  followed by "● 1. Keep trying   2. Stop" → send "2" to stop gracefully.
- Claude "❯ Result?" prompt → send "done" to complete the current turn.

Load /tsq-supervisor and follow its instructions to perform the health check.`,
		agentName, taskID, sessionID, logSection, troubleshootingPath, snapshotSection,
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
	project := util.Sanitize(filepath.Base(workDir))
	if project == "" || project == "." {
		project = "default"
	}
	dir := filepath.Join(home, ".tasksquad", "projects", project)
	os.MkdirAll(dir, 0755) //nolint:errcheck
	return filepath.Join(dir, "troubleshooting.md")
}

// printModeCmd builds a shell command that runs the CLI in print/non-interactive
// mode, piping the prompt from promptFile and appending stdout+stderr to logFile.
// daemonBinDir is prepended to PATH so the supervisor session can find the `tsq`
// binary (which may not be in the tmux environment's PATH).
//
// For non-Claude CLIs (gemini, opencode, codex): the supervisor instructions ask
// the CLI to curl POST /hooks/supervisor with its verdict. Claude supports this via
// --dangerously-skip-permissions (pre-approves bash/tool calls). Other CLIs run in
// non-interactive print mode and may not be able to execute shell commands, so the
// verdict curl never fires and waitForVerdictOrKill times out after 5 minutes.
//
// To fix this, we append a fallback curl after the CLI command using shell ";".
// If the CLI DID post a verdict: waitForVerdictOrKill receives it and kills the
// tmux session before the fallback runs. If the CLI exited WITHOUT a verdict:
// the fallback fires and delivers "cannot_help", unblocking spawn() immediately.
// Duplicate verdicts are safe — HandleVerdict rejects them with a "buffered channel full" no-op.
func printModeCmd(cli, promptFile, logFile, daemonBinDir, taskID string, hooksPort int) string {
	base := filepath.Base(cli)
	pathPrefix := ""
	if daemonBinDir != "" {
		pathPrefix = fmt.Sprintf("PATH=%s:$PATH ", daemonBinDir)
	}
	if strings.HasPrefix(base, "claude") {
		return fmt.Sprintf(`%scat %s | %s -p --dangerously-skip-permissions >> %s 2>&1`,
			pathPrefix, promptFile, cli, logFile)
	}
	// Non-Claude CLIs: append fallback verdict so spawn() is never blocked waiting
	// for a curl call the CLI is unable to make in non-interactive mode.
	fallbackCurl := fmt.Sprintf(
		`curl -sf -X POST http://localhost:%d/hooks/supervisor -H 'Content-Type: application/json' -d '{"task_id":"%s","status":"cannot_help","summary":"Supervisor CLI exited without posting verdict"}' > /dev/null 2>&1 || true`,
		hooksPort, taskID)
	return fmt.Sprintf(`%scat %s | %s >> %s 2>&1; %s`, pathPrefix, promptFile, cli, logFile, fallbackCurl)
}

// cleanOrphans scans tmux for tsq-sup-* sessions that are not actively managed
// by the current daemon run (left over from previous runs or crashes) and kills them.
func (s *Supervisor) cleanOrphans() {
	out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").Output()
	if err != nil {
		return // tmux not running or no sessions
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name := strings.TrimSpace(line)
		if !strings.HasPrefix(name, "tsq-sup-") {
			continue
		}
		suffix := strings.TrimPrefix(name, "tsq-sup-")
		isActive := false
		for taskID := range s.activeForTask {
			taskSuffix := taskID
			if len(taskSuffix) > 8 {
				taskSuffix = taskSuffix[:8]
			}
			if taskSuffix == suffix {
				isActive = true
				break
			}
		}
		if !isActive {
			logKill(name, tmux.KillSession(name))
			logger.Info(fmt.Sprintf("[supervisor] Orphan cleanup: killed %s", name))
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

// escalate is called when a task has exceeded maxSupervisorFailures consecutive
// no-verdict supervisor attempts. It posts a message to the task thread so the
// user knows manual intervention is required instead of silent infinite retries.
func (s *Supervisor) escalate(taskID, agentID string, attempts int) {
	if s.cfg == nil {
		return
	}
	body := fmt.Sprintf(
		"[Supervisor] Task has been stuck for %d supervision cycles (~%s) with no resolution. "+
			"Manual intervention required — check `tmux ls` or restart the agent.",
		attempts, time.Duration(attempts)*inactivityTimeout,
	)
	token, err := auth.GetToken(s.cfg.Firebase.APIKey, s.cfg.Server.URL)
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Auth failed for escalation (task %s): %v", taskID, err))
		return
	}
	_, err = api.Post(s.cfg, token, agentID, "/daemon/supervisor/report", map[string]any{
		"task_id": taskID,
		"body":    body,
		"type":    "escalation",
	})
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Failed to post escalation for task %s: %v", taskID, err))
		return
	}
	logger.Info(fmt.Sprintf("[supervisor] Escalation posted for task %s after %d failures", taskID, attempts))
}

// logKill logs a tmux kill-session error at Debug level; nil errors are silent.
func logKill(name string, err error) {
	if err != nil {
		logger.Debug(fmt.Sprintf("[supervisor] kill-session %s: %v (may be OK if already gone)", name, err))
	}
}

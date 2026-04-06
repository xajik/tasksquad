package supervisor

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/tmux"
	"github.com/tasksquad/daemon/util"
)

// safeIDRe accepts only ULID-style identifiers (alphanumeric, up to 32 chars).
// This prevents shell injection when IDs are embedded in command strings.
var safeIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// resolveSupervisorCLI resolves the binary path and full command from SupervisorConfig.
// Returns ("", "") if the command is empty or the binary cannot be found in PATH.
func resolveSupervisorCLI(scfg *config.SupervisorConfig) (cli, fullCmd string) {
	parts := strings.Fields(scfg.Command)
	if len(parts) == 0 {
		logger.Warn("[supervisor] supervisor.command is empty — supervisor disabled")
		return "", ""
	}
	p, err := exec.LookPath(parts[0])
	if err != nil {
		logger.Warn(fmt.Sprintf("[supervisor] supervisor CLI %q not found in PATH — supervisor disabled", parts[0]))
		return "", ""
	}
	logger.Info(fmt.Sprintf("[supervisor] Using supervisor command: %s", scfg.Command))
	return p, scfg.Command
}

// spawn starts a supervisor tmux session for the given stuck task.
func (s *Supervisor) spawn(a MonitoredAgent, taskID string) {
	defer func() {
		s.mu.Lock()
		delete(s.activeForTask, taskID)
		s.mu.Unlock()
	}()

	// Guard against shell injection: taskID must match the safe allowlist.
	if !safeIDRe.MatchString(taskID) {
		logger.Error(fmt.Sprintf("[supervisor] Rejecting unsafe taskID %q — contains disallowed characters", taskID))
		return
	}

	sessionName := "tsq-sup-" + taskID
	workDir := config.DefaultDir() // ~/.tasksquad — direct access to all logs
	agentWorkDir := a.WorkDir()
	agentTmux := a.TmuxSession()
	agentID := a.AgentID()
	logPath := a.LastLogPath()
	troubleshootPath := troubleshootingFile(agentWorkDir)
	supLog := SupervisorLogPath(taskID)

	if err := os.MkdirAll(filepath.Dir(supLog), 0755); err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Failed to create log dir: %v", err))
		return
	}

	tmuxSnapshot := captureTmuxPane(agentTmux, 50)
	contextBlock := buildContextBlock(a.Name(), taskID, agentTmux, logPath, troubleshootPath, tmuxSnapshot)

	header := fmt.Sprintf(
		"# TaskSquad Supervisor Log\n# agent=%s  task_id=%s\n# started=%s\n\n--- CONTEXT ---\n%s\n\n--- OUTPUT ---\n",
		a.Name(), taskID, time.Now().Format(time.RFC3339), contextBlock,
	)
	os.WriteFile(supLog, []byte(header), 0644) //nolint:errcheck

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

	shellCmd := printModeCmd(s.cli, s.fullCmd, promptFile, supLog, s.daemonBinDir, taskID, s.cfg.Hooks.Port)
	err = exec.Command("tmux", "new-session", "-d", "-s", sessionName,
		"-c", workDir, "sh", "-c", shellCmd).Run()
	if err != nil {
		logger.Error(fmt.Sprintf("[supervisor] Failed to start tmux session %s: %v", sessionName, err))
		return
	}
	logger.Info(fmt.Sprintf("[supervisor] Session %s started for task %s — attach: tmux attach-session -t %s",
		sessionName, taskID, sessionName))

	verdict, verdictFound := s.waitForVerdictOrKill(taskID, sessionName)

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

	if verdict.Status == VerdictWorkingFine {
		go s.notifyProgress(taskID, agentID, "Task is running well — picked up and in progress")
	} else {
		go s.reportToWorker(taskID, agentID, report)
	}
}

// captureTmuxPane returns the last n lines of a tmux pane's scrollback.
func captureTmuxPane(session string, lines int) string {
	if session == "" {
		return ""
	}
	return tmux.CapturePane(session, lines)
}

// buildContextBlock returns the initial message sent to the supervisor CLI.
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
func SupervisorLogPath(taskID string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".tasksquad", "logs", "supervisor", taskID+".log")
}

// troubleshootingFile returns the per-project troubleshooting notes path.
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

// printModeCmd builds a shell command that runs the CLI in print mode,
// piping the prompt from promptFile and appending output to logFile.
func printModeCmd(cli, fullCmd, promptFile, logFile, daemonBinDir, taskID string, hooksPort int) string {
	base := filepath.Base(cli)
	pathPrefix := ""
	if daemonBinDir != "" {
		pathPrefix = fmt.Sprintf("PATH=%s:$PATH ", daemonBinDir)
	}
	if strings.HasPrefix(base, "claude") {
		return fmt.Sprintf(`%scat %s | %s -p --dangerously-skip-permissions >> %s 2>&1`,
			pathPrefix, promptFile, cli, logFile)
	}
	fallbackCurl := fmt.Sprintf(
		`curl -sf -X POST http://localhost:%d/hooks/supervisor -H 'Content-Type: application/json' -d '{"task_id":"%s","status":"cannot_help","summary":"Supervisor CLI exited without posting verdict"}' > /dev/null 2>&1 || true`,
		hooksPort, taskID)
	return fmt.Sprintf(`%scat %s | %s >> %s 2>&1; %s`, pathPrefix, promptFile, fullCmd, logFile, fallbackCurl)
}

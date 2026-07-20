package dreamer

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

// safeIDRe accepts only short alphanumeric identifiers, the same allowlist
// supervisor.safeIDRe uses to guard shell/tmux-session-name interpolation.
// Duplicated here rather than imported since it's unexported in a sibling
// package — every identifier this package embeds in a session name is
// generated locally by shortID, so this is defense in depth rather than a
// validation of untrusted input.
var safeIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// resolveDreamerCLI resolves the binary path and full command to use for
// Dreaming sessions (both `tsq kb init` and the nightly Dreamer cycle).
// An explicit [dreamer] command wins; otherwise it falls back to
// [supervisor]'s command, matching "by default run by Supervisor, user can
// override". Returns ("", "") — Dreaming disabled — when neither section
// configures a usable CLI.
func resolveDreamerCLI(cfg *config.Config) (cli, fullCmd string) {
	if cfg.Dreamer != nil && cfg.Dreamer.Command != "" {
		return lookupCLI(cfg.Dreamer.Command, "dreamer.command")
	}
	if cfg.Supervisor != nil && cfg.Supervisor.Command != "" {
		logger.Info("[dreamer] No dreamer.command configured — falling back to supervisor.command")
		return lookupCLI(cfg.Supervisor.Command, "supervisor.command (fallback)")
	}
	logger.Warn("[dreamer] No dreamer.command or supervisor.command configured — Dreaming disabled")
	return "", ""
}

// lookupCLI resolves the first word of command against PATH, logging under
// label so a disabled Dreamer's cause is clear in the daemon log.
func lookupCLI(command, label string) (cli, fullCmd string) {
	parts := strings.Fields(command)
	if len(parts) == 0 {
		logger.Warn(fmt.Sprintf("[dreamer] %s is empty — Dreaming disabled", label))
		return "", ""
	}
	p, err := exec.LookPath(parts[0])
	if err != nil {
		logger.Warn(fmt.Sprintf("[dreamer] %s CLI %q not found in PATH — Dreaming disabled", label, parts[0]))
		return "", ""
	}
	logger.Info(fmt.Sprintf("[dreamer] Using %s: %s", label, command))
	return p, command
}

// printModeCmd builds a shell command that runs the CLI in print mode,
// piping the prompt from promptFile and appending output to logFile. Same
// shape as supervisor.printModeCmd — duplicated rather than shared since
// it's a few lines and unexported in a sibling package, consistent with how
// this codebase already duplicates memory's small helpers into kb.
func printModeCmd(cli, fullCmd, promptFile, logFile, daemonBinDir string) string {
	base := filepath.Base(cli)
	pathPrefix := ""
	if daemonBinDir != "" {
		pathPrefix = fmt.Sprintf("PATH=%s:$PATH ", daemonBinDir)
	}
	if strings.HasPrefix(base, "claude") {
		return fmt.Sprintf(`%scat %s | %s -p --dangerously-skip-permissions >> %s 2>&1`,
			pathPrefix, promptFile, cli, logFile)
	}
	return fmt.Sprintf(`%scat %s | %s >> %s 2>&1`, pathPrefix, promptFile, fullCmd, logFile)
}

// daemonBinDir returns the directory containing the running tsq binary, so
// spawned sessions can find `tsq` on PATH — same technique as supervisor.New.
func daemonBinDir() string {
	if exe, err := os.Executable(); err == nil {
		return filepath.Dir(exe)
	}
	return ""
}

// shortID returns a short random hex identifier safe to embed in a tmux
// session name and shell command (see safeIDRe).
func shortID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// safeSessionName validates id against safeIDRe and returns prefix+id, or an
// error if id contains characters unsafe to interpolate into a tmux session
// name and, in turn, a shell command line.
func safeSessionName(prefix, id string) (string, error) {
	if !safeIDRe.MatchString(id) {
		return "", fmt.Errorf("dreamer: unsafe session id %q", id)
	}
	return prefix + id, nil
}

// dreamerLogPath returns the per-session Dreaming log path, mirroring
// supervisor.SupervisorLogPath's shape under a new ~/.tasksquad/logs/dreamer/
// directory.
func dreamerLogPath(sessionSuffix string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".tasksquad", "logs", "dreamer", sessionSuffix+".log")
}

// spawnPrintModeSession starts a detached tmux session named sessionName at
// -c workDir, running the resolved CLI in print mode against promptContent
// and appending output to logPath. The prompt file is deleted by the spawned
// shell itself once the CLI has consumed it (rather than by the caller after
// the session completes, as supervisor.spawn does) so this is safe to call
// from a caller that doesn't wait for the session to finish — RunInit's
// fire-and-forget use case — as well as one that does — Dreamer.Monitor's
// nightly cycle.
func spawnPrintModeSession(cli, fullCmd, sessionName, workDir, promptContent, logPath string) error {
	// sessionName is always prefix+shortID (see safeSessionName), so the
	// full string — hyphens and alphanumerics only, well under 32 chars —
	// already satisfies safeIDRe; this is a second, defense-in-depth check
	// at the point the name actually reaches exec.Command.
	if !safeIDRe.MatchString(sessionName) {
		return fmt.Errorf("dreamer: unsafe session name %q", sessionName)
	}

	if err := os.MkdirAll(filepath.Dir(logPath), 0755); err != nil {
		return fmt.Errorf("create log dir: %w", err)
	}
	header := fmt.Sprintf("# TaskSquad Dreaming log\n# session=%s  work_dir=%s\n# started=%s\n\n",
		sessionName, workDir, time.Now().Format(time.RFC3339))
	if err := os.WriteFile(logPath, []byte(header), 0644); err != nil {
		return fmt.Errorf("write log header: %w", err)
	}

	tmpF, err := os.CreateTemp("", "tsq-dream-*.prompt")
	if err != nil {
		return fmt.Errorf("create prompt file: %w", err)
	}
	promptFile := tmpF.Name()
	if _, err := tmpF.WriteString(promptContent); err != nil {
		tmpF.Close()
		os.Remove(promptFile) //nolint:errcheck
		return fmt.Errorf("write prompt file: %w", err)
	}
	tmpF.Close()

	shellCmd := printModeCmd(cli, fullCmd, promptFile, logPath, daemonBinDir()) + "; rm -f " + promptFile
	if err := exec.Command("tmux", "new-session", "-d", "-s", sessionName,
		"-c", workDir, "sh", "-c", shellCmd).Run(); err != nil {
		os.Remove(promptFile) //nolint:errcheck
		return fmt.Errorf("tmux new-session: %w", err)
	}
	return nil
}

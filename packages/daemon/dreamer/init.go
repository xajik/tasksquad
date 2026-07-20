package dreamer

import (
	"fmt"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

// RunInit is called synchronously by `tsq kb init` (packages/daemon/cmd/kb)
// — a standalone CLI invocation, not part of the running daemon, matching
// the class of tsq init/tsq login. It resolves the dreamer CLI, builds a
// prompt instructing the agent to bootstrap tsq/kb/ via the /tsq-kb-builder
// skill, and starts a detached tmux print-mode session.
//
// It does not wait for the session to finish: tsq kb init is a synchronous
// one-off CLI call and the user is expected to attach and watch themselves —
// blocking the terminal for a potentially long KB-bootstrap run would be bad
// UX. The started session name and an attach hint are printed to stdout
// before returning.
func RunInit(cfg *config.Config, workDir, agentID string) error {
	cli, fullCmd := resolveDreamerCLI(cfg)
	if cli == "" {
		return fmt.Errorf("dreamer disabled — configure [dreamer] or [supervisor] command in %s", config.DefaultPath())
	}

	id := shortID()
	sessionName, err := safeSessionName("tsq-kbinit-", id)
	if err != nil {
		return err
	}
	logPath := dreamerLogPath("kbinit-" + id)

	if err := spawnPrintModeSession(cli, fullCmd, sessionName, workDir, buildInitPrompt(workDir, agentID), logPath); err != nil {
		return fmt.Errorf("start kb init session: %w", err)
	}

	logger.Info(fmt.Sprintf("[dreamer] kb init session %s started for %s — log: %s", sessionName, workDir, logPath))
	fmt.Printf("KB bootstrap started: %s\n", sessionName)
	fmt.Printf("Attach to watch: tmux attach-session -t %s\n", sessionName)
	fmt.Printf("Log: %s\n", logPath)
	return nil
}

// buildInitPrompt builds the initial message sent to the bootstrap CLI.
func buildInitPrompt(workDir, agentID string) string {
	return fmt.Sprintf(
		`You are bootstrapping a project knowledge base for TaskSquad Dreaming.

Working directory: %s
Agent ID:          %s

Load /tsq-kb-builder and follow its instructions to build tsq/kb/ from scratch, then commit and push.`,
		workDir, agentID,
	)
}

package agents

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/tasksquad/daemon/harness"
	"github.com/tasksquad/daemon/logger"
)

// installAgent writes content to <workDir>/.tsq/agents/<name>.md
// and copies it to .claude/agents/<name>.md, .agents/agents/<name>.md, and .gemini/agents/<name>.md
// for compatibility with various agent tools.
func installAgent(workDir string, agent remoteAgent) error {
	dir := filepath.Join(workDir, ".tsq", "agents")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	src := filepath.Join(dir, agent.Name+".md")
	if err := os.WriteFile(src, []byte(agent.Content), 0644); err != nil {
		return err
	}

	for _, cd := range harness.AgentDirs(workDir) {
		os.MkdirAll(cd, 0755) //nolint:errcheck
		dest := filepath.Join(cd, agent.Name+".md")
		if err := harness.CopyFile(src, dest); err != nil {
			logger.Warn(fmt.Sprintf("[agents] Failed to copy sub-agent %q to %s: %v", agent.Name, dest, err))
		}
	}

	return nil
}

// removeAgent deletes the sub-agent from .tsq/agents and its provider copies.
func removeAgent(workDir, name string) {
	os.Remove(filepath.Join(workDir, ".tsq", "agents", name+".md")) //nolint:errcheck

	for _, cd := range harness.AgentDirs(workDir) {
		os.Remove(filepath.Join(cd, name+".md")) //nolint:errcheck
	}
}

// ─── Lock file helpers ────────────────────────────────────────────────────────

func lockPath(workDir string) string {
	home, _ := os.UserHomeDir()
	h := sha256.Sum256([]byte(workDir))
	name := fmt.Sprintf("agents-%x.lock", h[:8])
	return filepath.Join(home, ".tasksquad", name)
}

func loadLock(workDir string) agentsLock {
	lock := agentsLock{}
	data, err := os.ReadFile(lockPath(workDir))
	if err != nil {
		return lock
	}
	json.Unmarshal(data, &lock) //nolint:errcheck
	return lock
}

func saveLock(workDir string, lock agentsLock) {
	path := lockPath(workDir)
	os.MkdirAll(filepath.Dir(path), 0755) //nolint:errcheck
	data, _ := json.Marshal(lock)
	os.WriteFile(path, data, 0600) //nolint:errcheck
}

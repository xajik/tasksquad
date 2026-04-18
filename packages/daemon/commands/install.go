package commands

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/tasksquad/daemon/harness"
	"github.com/tasksquad/daemon/logger"
)

func installCommand(workDir string, cmd remoteCommand) error {
	// Write the canonical copy under .tsq/commands/<name>.md
	dir := filepath.Join(workDir, ".tsq", "commands")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	src := filepath.Join(dir, cmd.Name+".md")
	if err := os.WriteFile(src, []byte(cmd.Content), 0644); err != nil {
		return err
	}

	// Copy to every harness command directory
	for _, cd := range harness.CommandDirs(workDir) {
		os.MkdirAll(cd, 0755) //nolint:errcheck
		dest := filepath.Join(cd, cmd.Name+".md")
		if err := harness.CopyFile(src, dest); err != nil {
			logger.Warn(fmt.Sprintf("[commands] Failed to copy %q to %s: %v", cmd.Name, dest, err))
		}
	}

	return nil
}

func removeCommand(workDir, name string) {
	os.Remove(filepath.Join(workDir, ".tsq", "commands", name+".md")) //nolint:errcheck

	for _, cd := range harness.CommandDirs(workDir) {
		os.Remove(filepath.Join(cd, name+".md")) //nolint:errcheck
	}
}

func lockPath(workDir string) string {
	home, _ := os.UserHomeDir()
	h := sha256.Sum256([]byte(workDir))
	name := fmt.Sprintf("commands-%x.lock", h[:8])
	return filepath.Join(home, ".tasksquad", name)
}

func loadLock(workDir string) commandsLock {
	lock := commandsLock{}
	data, err := os.ReadFile(lockPath(workDir))
	if err != nil {
		return lock
	}
	json.Unmarshal(data, &lock) //nolint:errcheck
	return lock
}

func saveLock(workDir string, lock commandsLock) {
	path := lockPath(workDir)
	os.MkdirAll(filepath.Dir(path), 0755) //nolint:errcheck
	data, _ := json.Marshal(lock)
	os.WriteFile(path, data, 0600) //nolint:errcheck
}

package skills

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/tasksquad/daemon/logger"
)

// installSkill writes content to <workDir>/.tsq/skills/<name>/SKILL.md
// and symlinks it to .claude/skills/<name> and .agents/skills/<name>
// for compatibility with various agent tools.
func installSkill(workDir string, skill remoteSkill) error {
	dir := skillDir(workDir, skill.Name)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(skill.Content), 0644); err != nil {
		return err
	}

	linkDirs := []string{
		filepath.Join(workDir, ".claude", "skills"),
		filepath.Join(workDir, ".agents", "skills"),
	}
	for _, ld := range linkDirs {
		os.MkdirAll(ld, 0755) //nolint:errcheck

		target := filepath.Join(ld, skill.Name)
		os.RemoveAll(target) //nolint:errcheck

		// Use relative path so symlinks remain portable across machines.
		relPath := filepath.Join("..", "..", ".tsq", "skills", skill.Name)
		if err := os.Symlink(relPath, target); err != nil {
			logger.Warn(fmt.Sprintf("[skills] Failed to create symlink at %s: %v", target, err))
		}
	}

	return nil
}

// removeSkill deletes the skill from .tsq/skills and its symlinks.
func removeSkill(workDir, name string) {
	os.RemoveAll(skillDir(workDir, name)) //nolint:errcheck

	for _, ld := range []string{".claude/skills", ".agents/skills"} {
		os.Remove(filepath.Join(workDir, ld, name)) //nolint:errcheck
	}
}

// skillDir returns the canonical on-disk directory for a skill.
func skillDir(workDir, name string) string {
	return filepath.Join(workDir, ".tsq", "skills", name)
}

// fileExists reports whether path exists on disk.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// ─── Lock file helpers ───────────────────────────────────────────────────────���

func lockPath(workDir string) string {
	home, _ := os.UserHomeDir()
	h := sha256.Sum256([]byte(workDir))
	name := fmt.Sprintf("skills-%x.lock", h[:8])
	return filepath.Join(home, ".tasksquad", name)
}

func loadLock(workDir string) skillsLock {
	lock := skillsLock{}
	data, err := os.ReadFile(lockPath(workDir))
	if err != nil {
		return lock
	}
	json.Unmarshal(data, &lock) //nolint:errcheck
	return lock
}

func saveLock(workDir string, lock skillsLock) {
	path := lockPath(workDir)
	os.MkdirAll(filepath.Dir(path), 0755) //nolint:errcheck
	data, _ := json.Marshal(lock)
	os.WriteFile(path, data, 0600) //nolint:errcheck
}

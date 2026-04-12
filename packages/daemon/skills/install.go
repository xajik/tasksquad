package skills

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/tasksquad/daemon/harness"
	"github.com/tasksquad/daemon/logger"
)

// installSkill writes content to <workDir>/.tsq/skills/<name>/SKILL.md
// and copies it to .claude/skills/<name>, .agents/skills/<name>, and .gemini/skills/<name>
// for compatibility with various agent tools.
func installSkill(workDir string, skill remoteSkill) error {
	dir := skillDir(workDir, skill.Name)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(skill.Content), 0644); err != nil {
		return err
	}

	for _, cd := range harness.SkillDirs(workDir) {
		os.MkdirAll(cd, 0755) //nolint:errcheck

		dest := filepath.Join(cd, skill.Name)
		if err := copyDir(dir, dest); err != nil {
			logger.Warn(fmt.Sprintf("[skills] Failed to copy skill %q to %s: %v", skill.Name, dest, err))
		}
	}

	return nil
}

// removeSkill deletes the skill from .tsq/skills and its copies.
// Only server-managed skills (tracked in the lock file) are ever passed here,
// so user-created skills in provider directories are never touched.
func removeSkill(workDir, name string) {
	os.RemoveAll(skillDir(workDir, name)) //nolint:errcheck

	for _, cd := range harness.SkillDirs(workDir) {
		os.RemoveAll(filepath.Join(cd, name)) //nolint:errcheck
	}
}

// copyDir copies all files from src directory into dst directory.
// dst is created if it does not exist. Existing files are overwritten.
func copyDir(src, dst string) error {
	if err := os.MkdirAll(dst, 0755); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue // skill dirs are flat; skip subdirectories
		}
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())
		if err := harness.CopyFile(srcPath, dstPath); err != nil {
			return err
		}
	}
	return nil
}

// skillDir returns the canonical on-disk directory for a skill.
func skillDir(workDir, name string) string {
	return filepath.Join(workDir, ".tsq", "skills", name)
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

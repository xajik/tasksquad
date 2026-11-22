package skills

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/tasksquad/daemon/harness"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/util"
)

// installSkill writes content to <workDir>/.tsq/skills/<name>/SKILL.md
// and copies it to .claude/skills/<name>, .agents/skills/<name>, and .gemini/skills/<name>
// for compatibility with various agent tools.
func installSkill(workDir string, skill remoteSkill, lock skillsLock) error {
	if !util.ValidResourceName(skill.Name) {
		return fmt.Errorf("unsafe skill name %q", skill.Name)
	}

	dir := skillDir(workDir, skill.Name)
	if info, lErr := os.Lstat(dir); lErr == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			os.RemoveAll(dir) //nolint:errcheck
		}
	} else if !os.IsNotExist(lErr) {
		return lErr
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(skill.Content), 0644); err != nil {
		return err
	}

	// Server-managed skills always win: a locally edited or stale copy is overwritten.
	for _, cd := range harness.SkillDirs(workDir) {
		if cd == filepath.Join(workDir, ".agents", "skills") {
			// InstallCodexSkill leaves an unmarked same-name file alone; the server copy takes over.
			_ = os.Remove(filepath.Join(cd, skill.Name, "SKILL.md"))
			if err := harness.InstallCodexSkill(workDir, skill.Name, skill.Content); err != nil {
				return err
			}
			continue
		}
		dest := filepath.Join(cd, skill.Name)
		if err := os.MkdirAll(dest, 0755); err != nil {
			logger.Warn(fmt.Sprintf("[skills] Failed to create %s: %v", dest, err))
			continue
		}
		if err := os.WriteFile(filepath.Join(dest, "SKILL.md"), []byte(skill.Content), 0644); err != nil {
			logger.Warn(fmt.Sprintf("[skills] Failed to copy skill %q to %s: %v", skill.Name, dest, err))
		}
	}

	lock[skill.Name] = skill.Etag
	return nil
}

// removeSkill deletes a server-managed skill from .tsq/skills and every provider
// copy, whether or not it was edited locally. Only skills tracked in the lock file
// (installed by the sync) are ever passed here, so custom user skills that the
// server never provided are never touched.
func removeSkill(workDir, name string) {
	if !util.ValidResourceName(name) {
		return
	}
	_ = os.Remove(filepath.Join(skillDir(workDir, name), "SKILL.md"))
	_ = os.Remove(skillDir(workDir, name))

	for _, cd := range harness.SkillDirs(workDir) {
		_ = os.Remove(filepath.Join(cd, name, "SKILL.md"))
		_ = os.Remove(filepath.Join(cd, name)) // fails (kept) if the user added other files
	}
}

// inSync reports whether every on-disk copy of a skill is byte-identical to the
// server version. The server etag is the SHA-256 of the content, so a locally
// edited, truncated or deleted copy shows up as a mismatch and is re-fetched.
func inSync(workDir, name, etag string) bool {
	if etag == "" {
		return false
	}
	matches := func(path string) bool {
		b, err := os.ReadFile(path)
		if err != nil {
			return false
		}
		sum := sha256.Sum256(b)
		return hex.EncodeToString(sum[:]) == etag
	}
	if !matches(filepath.Join(skillDir(workDir, name), "SKILL.md")) {
		return false
	}
	for _, cd := range harness.SkillDirs(workDir) {
		p := filepath.Join(cd, name, "SKILL.md")
		if cd == filepath.Join(workDir, ".agents", "skills") {
			// Codex copies carry a managed marker, so only check they exist.
			if _, err := os.Stat(p); err != nil {
				return false
			}
			continue
		}
		if !matches(p) {
			return false
		}
	}
	return true
}

// copyDir copies all files from src directory into dst directory.
// dst is created if it does not exist. Existing files are overwritten.
func copyDir(src, dst string) error {
	if info, err := os.Lstat(dst); err == nil && info.Mode()&os.ModeSymlink != 0 {
		os.RemoveAll(dst) //nolint:errcheck
	}
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

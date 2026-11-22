package skills

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/util"
)

// The built-in default skills ship inside the daemon so that the skills the server
// names in its default close steps (/tsq-end-session-learning, /tsq-end-session-memory,
// /tsq-cleanup) exist in every work directory even when the server's skill list does
// not return them. Keep defaults/ in step with packages/worker/resources/defaults
// (defaults_test.go fails when they drift).
//
//go:embed defaults/*.md
var defaultFS embed.FS

// closeStepDefaults are the default skills the server runs as session close steps.
// They are topped up automatically on every skill sync and before a close sequence.
var closeStepDefaults = []string{"tsq-end-session-learning", "tsq-end-session-memory", "tsq-cleanup"}

// DefaultNames returns the names of all built-in default skills, sorted.
func DefaultNames() []string {
	entries, _ := defaultFS.ReadDir("defaults")
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, strings.TrimSuffix(e.Name(), ".md"))
	}
	sort.Strings(names)
	return names
}

// IsDefault reports whether name is a built-in default skill.
func IsDefault(name string) bool {
	_, err := defaultFS.ReadFile("defaults/" + name + ".md")
	return util.ValidResourceName(name) && err == nil
}

// CloseStepDefaults returns the default skills used by the server's close steps.
func CloseStepDefaults() []string { return append([]string{}, closeStepDefaults...) }

// Installed reports whether a skill already exists in workDir, either as the
// canonical copy written by the daemon or as a copy in an agent skill directory.
func Installed(workDir, name string) bool {
	if _, err := os.Stat(filepath.Join(skillDir(workDir, name), "SKILL.md")); err == nil {
		return true
	}
	for _, rel := range []string{".claude/skills", ".agents/skills", ".gemini/skills", ".pi/skills", ".forge/skills"} {
		if _, err := os.Stat(filepath.Join(workDir, rel, name, "SKILL.md")); err == nil {
			return true
		}
	}
	return false
}

// EnsureDefaults installs each named built-in default skill into workDir when it is
// missing. A nil or empty names list means every built-in default. Existing copies,
// including server-managed and user-edited ones, are never overwritten. It returns the
// names it installed. Skills installed here are deliberately not recorded in the sync
// lock: the lock marks server-managed skills, and the next sync would remove any
// lock entry the server does not list.
func EnsureDefaults(workDir string, names []string) ([]string, error) {
	if workDir == "" {
		return nil, fmt.Errorf("empty work directory")
	}
	if len(names) == 0 {
		names = DefaultNames()
	}
	var installed []string
	var firstErr error
	for _, name := range names {
		body, err := defaultFS.ReadFile("defaults/" + name + ".md")
		if err != nil || !util.ValidResourceName(name) {
			if firstErr == nil {
				firstErr = fmt.Errorf("%q is not a built-in default skill", name)
			}
			continue
		}
		if Installed(workDir, name) {
			continue
		}
		sum := sha256.Sum256(body)
		skill := remoteSkill{Name: name, Content: string(body), Etag: hex.EncodeToString(sum[:]), IsDefault: 1}
		if err := installSkill(workDir, skill, skillsLock{}); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("install %q: %w", name, err)
			}
			continue
		}
		logger.Info(fmt.Sprintf("[skills] Installed built-in default %q → %s (missing)", name, workDir))
		installed = append(installed, name)
	}
	return installed, firstErr
}

// EnsureStepSkills installs any built-in default skill that a close step needs and
// that is missing from workDir. Steps that do not name a built-in default are ignored.
func EnsureStepSkills(workDir string, steps []string) []string {
	var need []string
	seen := map[string]bool{}
	for _, step := range steps {
		if name := StepSkillName(step); name != "" && !seen[name] && IsDefault(name) {
			seen[name] = true
			need = append(need, name)
		}
	}
	if len(need) == 0 {
		return nil
	}
	installed, err := EnsureDefaults(workDir, need)
	if err != nil {
		logger.Warn(fmt.Sprintf("[skills] Could not install close-step skills in %s: %v", workDir, err))
	}
	return installed
}

// StepSkillName extracts the skill a close step invokes: "/tsq-cleanup" or
// "$tsq-cleanup extra words" both give "tsq-cleanup". It returns "" for anything else.
func StepSkillName(step string) string {
	step = strings.TrimSpace(step)
	if step == "" || (step[0] != '/' && step[0] != '$') {
		return ""
	}
	name := strings.Fields(step[1:])
	if len(name) == 0 || !util.ValidResourceName(name[0]) {
		return ""
	}
	return name[0]
}

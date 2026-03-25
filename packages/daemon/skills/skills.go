package skills

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

// AgentRef is the minimal interface this package needs from an agent.
type AgentRef interface {
	AgentID() string
	WorkDir() string
}

// remoteSkill is the server-side skill shape from GET /teams/:teamId/skills.
type remoteSkill struct {
	ID          string
	TeamID      string
	Name        string
	Description string
	Content     string
	Etag        string
	Version     int
	IsDefault   int
	AutoInstall int
}

// skillsLock is the on-disk JSON structure tracking which skills are installed.
// Key: skill name, value: etag.
type skillsLock map[string]string

// skillPayload is the structured JSON response we request from the agent CLI.
type skillPayload struct {
	Skills []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Content     string `json:"content"`
	} `json:"skills"`
}

// ─── Session-close extraction ─────────────────────────────────────────────────

// ExtractFromSession is called after a daemon session closes.
// It invokes the CLI tool with a structured prompt to extract reusable learnings
// as skills, then POSTs them to /daemon/skills.
// Safe to call in a goroutine — logs errors and returns silently.
func ExtractFromSession(cfg *config.Config, agentID, tmuxCapture string) {
	if cfg == nil || agentID == "" || tmuxCapture == "" {
		return
	}

	// Trim to last 8000 chars to stay within context limits
	capture := tmuxCapture
	if len(capture) > 8000 {
		capture = capture[len(capture)-8000:]
	}

	cli := detectCLI()
	if cli == "" {
		logger.Warn("[skills] No CLI tool found — skipping skill extraction")
		return
	}

	prompt := buildExtractionPrompt(capture)
	output, err := runCLI(cli, prompt, 60*time.Second)
	if err != nil {
		logger.Warn(fmt.Sprintf("[skills] CLI extraction failed: %v", err))
		return
	}

	payload, err := parseSkillsResponse(output)
	if err != nil || len(payload.Skills) == 0 {
		logger.Debug("[skills] No new skills from session")
		return
	}

	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		logger.Error(fmt.Sprintf("[skills] Auth failed: %v", err))
		return
	}

	for _, s := range payload.Skills {
		if s.Name == "" || s.Content == "" {
			continue
		}
		if !strings.HasPrefix(s.Name, "tsq-") {
			logger.Warn(fmt.Sprintf("[skills] Skipping %q — name must start with tsq-", s.Name))
			continue
		}
		_, err := api.Post(cfg, token, agentID, "/daemon/skills", map[string]any{
			"name":        s.Name,
			"description": s.Description,
			"content":     s.Content,
		})
		if err != nil {
			logger.Error(fmt.Sprintf("[skills] Failed to upload %q: %v", s.Name, err))
		} else {
			logger.Info(fmt.Sprintf("[skills] Uploaded skill %q", s.Name))
		}
	}
}

// buildExtractionPrompt returns the prompt sent to the CLI tool after a session.
func buildExtractionPrompt(sessionOutput string) string {
	return fmt.Sprintf(`Review the following agent session output.

Your task: identify if the session contains any reusable learning that would help future agents avoid mistakes or solve recurring problems. Focus on:
- Non-obvious fixes or workarounds discovered during the task
- Tool usage patterns that were tricky to figure out
- Specific steps required to solve a repeated problem

If you identify useful learnings, produce skills. If the session was routine or trivial, respond with an empty list.

Each skill content must follow this format with YAML frontmatter:
---
name: tsq-<kebab-case-name>
description: <one-line description>
---

<step-by-step instructions>

Rules:
- All skill names MUST start with "tsq-"
- Only create skills for non-trivial, reusable learnings
- Do not create skills for one-off tasks
- Keep content concise but actionable

Respond ONLY with valid JSON in this exact shape — no other text:
{"skills": [{"name": "tsq-example", "description": "...", "content": "---\nname: tsq-example\ndescription: ...\n---\n\n..."}]}

If there are no new learnings, respond with:
{"skills": []}

Session output:
%s`, sessionOutput)
}

// parseSkillsResponse extracts the JSON payload from CLI output.
// The CLI may produce preamble text before the JSON.
func parseSkillsResponse(output string) (skillPayload, error) {
	// Find the JSON object containing "skills"
	start := strings.Index(output, `{"skills"`)
	if start < 0 {
		start = strings.Index(output, "{")
	}
	end := strings.LastIndex(output, "}")
	if start < 0 || end <= start {
		return skillPayload{}, fmt.Errorf("no JSON found")
	}
	var p skillPayload
	if err := json.Unmarshal([]byte(output[start:end+1]), &p); err != nil {
		return skillPayload{}, err
	}
	return p, nil
}

// runCLI executes the CLI binary with -p <prompt> and returns stdout.
// Uses --dangerously-skip-permissions to avoid interactive prompts.
func runCLI(cli, prompt string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, cli, "--dangerously-skip-permissions", "-p", prompt)
	out, err := cmd.Output()
	if err != nil {
		// Include stderr in error message if available
		if exitErr, ok := err.(*exec.ExitError); ok && len(exitErr.Stderr) > 0 {
			return "", fmt.Errorf("%w: %s", err, exitErr.Stderr)
		}
		return "", err
	}
	return string(out), nil
}

// ─── Periodic sync ─────────────────────────────────────────────────────────────

// Syncer allows external code to trigger an immediate skills sync.
type Syncer struct {
	triggerCh chan struct{}
}

// NewSyncer creates a Syncer.
func NewSyncer() *Syncer {
	return &Syncer{triggerCh: make(chan struct{}, 1)}
}

// ForceSync triggers an immediate skills sync (non-blocking; no-op if already pending).
func (s *Syncer) ForceSync() {
	select {
	case s.triggerCh <- struct{}{}:
	default:
	}
}

// StartSync polls the server every hour for auto_install skills and syncs them
// to each agent's work directory. Safe to call in a goroutine.
func StartSync(cfg *config.Config, agents []AgentRef, syncer *Syncer) {
	if cfg == nil || len(agents) == 0 {
		return
	}
	logger.Info("[skills] Auto-install sync started (interval=1h)")
	syncSkills(cfg, agents) // immediate sync on startup so new projects get skills right away
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			syncSkills(cfg, agents)
		case <-syncer.triggerCh:
			logger.Info("[skills] force-sync triggered")
			syncSkills(cfg, agents)
		}
	}
}

func syncSkills(cfg *config.Config, agents []AgentRef) {
	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		logger.Error(fmt.Sprintf("[skills] Sync auth failed: %v", err))
		return
	}

	seen := map[string]bool{}
	for _, a := range agents {
		wd := a.WorkDir()
		if wd == "" || seen[wd] {
			continue
		}
		seen[wd] = true
		syncAgentSkills(cfg, token, a.AgentID(), wd)
	}
}

func syncAgentSkills(cfg *config.Config, token, agentID, workDir string) {
	// Fetch skills list for this agent's team.
	// We re-use GET /daemon/user/skills?agent_id=... which the server resolves
	// to the agent's team skills + defaults.
	resp, err := api.Get(cfg, token, "/daemon/user/skills?agent_id="+agentID)
	if err != nil {
		logger.Error(fmt.Sprintf("[skills] Sync fetch failed for agent %s: %v", agentID, err))
		return
	}

	raw, _ := resp["skills"].([]any)
	lock := loadLock(workDir)
	serverNames := map[string]bool{}

	if len(raw) > 0 {
		logger.Debug(fmt.Sprintf("[skills] Sync found %d potential skills for agent %s", len(raw), agentID))
	}

	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		skill := remoteSkillFromMap(m)
		if skill.AutoInstall == 0 && skill.IsDefault == 0 {
			continue
		}
		serverNames[skill.Name] = true

		if lock[skill.Name] == skill.Etag && skill.Etag != "" {
			// Check if the file actually exists on disk. If not, re-install it.
			skillDir := filepath.Join(workDir, ".tsq", "skills", skill.Name)
			if _, err := os.Stat(filepath.Join(skillDir, "SKILL.md")); err == nil {
				continue // already up to date and exists
			}
		}

		// Fetch full content if not in list response
		if skill.Content == "" && skill.ID != "" && skill.TeamID != "" {
			full, err := api.Get(cfg, token, fmt.Sprintf("/teams/%s/skills/%s", skill.TeamID, skill.ID))
			if err != nil {
				logger.Error(fmt.Sprintf("[skills] Failed to fetch skill %q content: %v", skill.Name, err))
				continue
			}
			skill.Content, _ = full["content"].(string)
			if e, ok := full["etag"].(string); ok && e != "" {
				skill.Etag = e
			}
		}

		if skill.Content == "" {
			logger.Warn(fmt.Sprintf("[skills] Skipping %q — no content received", skill.Name))
			continue
		}

		if err := installSkill(workDir, skill); err != nil {
			logger.Error(fmt.Sprintf("[skills] Failed to install %q: %v", skill.Name, err))
			continue
		}
		lock[skill.Name] = skill.Etag
		logger.Info(fmt.Sprintf("[skills] Installed %q v%d → %s", skill.Name, skill.Version, workDir))
	}

	// Remove skills that were deleted on the server
	for name := range lock {
		if !serverNames[name] {
			removeSkill(workDir, name)
			delete(lock, name)
			logger.Info(fmt.Sprintf("[skills] Removed %q from %s (deleted on server)", name, workDir))
		}
	}

	saveLock(workDir, lock)
}

// installSkill writes content to <workDir>/.tsq/skills/<name>/SKILL.md
// and symlinks it to <workDir>/.claude/skills/<name> and <workDir>/.agents/skills/<name>
// for compatibility with various agent tools.
func installSkill(workDir string, skill remoteSkill) error {
	tsqDir := filepath.Join(workDir, ".tsq", "skills", skill.Name)
	if err := os.MkdirAll(tsqDir, 0755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(tsqDir, "SKILL.md"), []byte(skill.Content), 0644); err != nil {
		return err
	}

	// Symlink targets for different agent tools
	linkDirs := []string{
		filepath.Join(workDir, ".claude", "skills"),
		filepath.Join(workDir, ".agents", "skills"),
	}

	for _, dir := range linkDirs {
		os.MkdirAll(dir, 0755) //nolint:errcheck

		target := filepath.Join(dir, skill.Name)
		os.RemoveAll(target) //nolint:errcheck

		// Use relative path for symlink to keep it portable (../../.tsq/skills/<name>)
		relPath := filepath.Join("..", "..", ".tsq", "skills", skill.Name)
		if err := os.Symlink(relPath, target); err != nil {
			logger.Warn(fmt.Sprintf("[skills] Failed to create symlink at %s: %v", target, err))
		}
	}

	return nil
}

// removeSkill deletes the skill from .tsq/skills and its symlinks.
func removeSkill(workDir, name string) {
	tsqDir := filepath.Join(workDir, ".tsq", "skills", name)
	os.RemoveAll(tsqDir) //nolint:errcheck

	linkPaths := []string{
		filepath.Join(workDir, ".claude", "skills", name),
		filepath.Join(workDir, ".agents", "skills", name),
	}
	for _, p := range linkPaths {
		os.Remove(p) //nolint:errcheck
	}
}

// ─── Lock file helpers ────────────────────────────────────────────────────────

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

// ─── Misc helpers ─────────────────────────────────────────────────────────────

func remoteSkillFromMap(m map[string]any) remoteSkill {
	s := remoteSkill{}
	s.ID, _ = m["id"].(string)
	s.TeamID, _ = m["team_id"].(string)
	s.Name, _ = m["name"].(string)
	s.Description, _ = m["description"].(string)
	s.Content, _ = m["content"].(string)
	s.Etag, _ = m["etag"].(string)
	if v, ok := m["auto_install"].(float64); ok {
		s.AutoInstall = int(v)
	}
	if v, ok := m["is_default"].(float64); ok {
		s.IsDefault = int(v)
	}
	if v, ok := m["version"].(float64); ok {
		s.Version = int(v)
	}
	return s
}

func detectCLI() string {
	for _, name := range []string{"claude", "gemini", "opencode", "codex"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return ""
}

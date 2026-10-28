package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Resumer is implemented by providers whose CLI can reopen one of its own
// earlier sessions by ID (the one its hooks report as session_id / thread-id).
// When a task's process is gone (the CLI or tmux died while waiting for
// input, or the daemon restarted), the next reply re-spawns the CLI on that
// session, so it keeps its own history (tool calls, files read) instead of
// getting the thread replayed as plain text.
type Resumer interface {
	// ResumeArgs returns args (everything after the binary, including
	// ExtraArgs and SetupArgs) changed to reopen CLI session id. Any
	// InitialPromptArgs are appended afterwards.
	ResumeArgs(args []string, id string) []string
	// CanResume reports whether session id is in the CLI's local session
	// store, i.e. whether ResumeArgs can work on this machine. command is the
	// agent's configured command (its first field is the CLI binary) and
	// workDir the directory the CLI runs in.
	CanResume(command, workDir, id string) bool
}

// resumeIDRe matches the IDs the worker accepts. IDs land on the command line,
// so anything that could be read as a flag or path is rejected here too.
var resumeIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// ValidResumeID reports whether id is safe to pass to a CLI as a session ID.
func ValidResumeID(id string) bool {
	return resumeIDRe.MatchString(id) && !strings.Contains(id, "..")
}

// homeDir returns $env when set, else ~/<dir>.
func homeDir(env, dir string) string {
	if v := os.Getenv(env); env != "" && v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, dir)
}

// ResumeArgs appends --resume: `claude … --resume <id>`. Claude Code keeps the
// session ID when resuming (unless --fork-session), so later hooks report the
// same ID.
func (p *ClaudeCode) ResumeArgs(args []string, id string) []string {
	return append(append([]string{}, args...), "--resume", id)
}

// CanResume looks for ~/.claude/projects/<encoded cwd>/<id>.jsonl. The cwd
// encoding has changed between Claude Code versions, so any project directory
// is accepted.
func (p *ClaudeCode) CanResume(_, _, id string) bool {
	if !ValidResumeID(id) {
		return false
	}
	root := homeDir("CLAUDE_CONFIG_DIR", ".claude")
	if root == "" {
		return false
	}
	matches, _ := filepath.Glob(filepath.Join(root, "projects", "*", id+".jsonl"))
	return len(matches) > 0
}

// ResumeArgs uses the resume subcommand: `codex resume [options] <id> -- <prompt>`.
// It accepts the same options as the interactive TUI (--no-alt-screen, -c
// notify=…), so the user's args and SetupArgs move behind it unchanged.
func (p *Codex) ResumeArgs(args []string, id string) []string {
	out := append([]string{"resume"}, args...)
	return append(out, id)
}

// codexRolloutPrefixRe is the part of a rollout file name before "-<id>.jsonl".
// Matching it whole keeps a partial id (UUIDs contain "-") from matching.
var codexRolloutPrefixRe = regexp.MustCompile(`^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$`)

// CanResume looks for $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl.
func (p *Codex) CanResume(_, _, id string) bool {
	if !ValidResumeID(id) {
		return false
	}
	root := homeDir("CODEX_HOME", ".codex")
	if root == "" {
		return false
	}
	suffix := "-" + id + ".jsonl"
	found := false
	filepath.WalkDir(filepath.Join(root, "sessions"), func(path string, d fs.DirEntry, err error) error { //nolint:errcheck
		if err != nil {
			return nil // unreadable entry or missing store: keep looking / nothing found
		}
		if name := d.Name(); !d.IsDir() && strings.HasSuffix(name, suffix) && codexRolloutPrefixRe.MatchString(strings.TrimSuffix(name, suffix)) {
			found = true
			return fs.SkipAll
		}
		return nil
	})
	return found
}

// ResumeArgs appends --resume: `gemini … --resume <uuid>`. Gemini's hooks
// report the session UUID as session_id.
func (p *Gemini) ResumeArgs(args []string, id string) []string {
	return append(append([]string{}, args...), "--resume", id)
}

// CanResume looks for a chat file under ~/.gemini/tmp/<project hash>/chats/
// that records this session. The file names carry only part of the UUID, so
// the file contents are checked for the full id.
func (p *Gemini) CanResume(_, _, id string) bool {
	if !ValidResumeID(id) {
		return false
	}
	root := homeDir("", ".gemini")
	if root == "" {
		return false
	}
	files, _ := filepath.Glob(filepath.Join(root, "tmp", "*", "chats", "*.json"))
	needle := []byte(`"` + id + `"`)
	for _, f := range files {
		if data, err := os.ReadFile(f); err == nil && bytes.Contains(data, needle) {
			return true
		}
	}
	return false
}

// ResumeArgs appends --session: `opencode … --session <ses_…>`.
func (p *OpenCode) ResumeArgs(args []string, id string) []string {
	return append(append([]string{}, args...), "--session", id)
}

// openCodeListTimeout bounds `opencode session list`, which runs only when a
// task is re-spawned.
const openCodeListTimeout = 15 * time.Second

// CanResume asks the CLI itself: OpenCode keeps sessions in a SQLite database
// (opencode.db), which a cgo-free daemon can't open. The listing is scoped to
// the project in workDir, which is where the task resumes.
func (p *OpenCode) CanResume(command, workDir, id string) bool {
	if !ValidResumeID(id) {
		return false
	}
	bin := p.CLIName()
	if fields := strings.Fields(command); len(fields) > 0 {
		bin = fields[0]
	}
	ctx, cancel := context.WithTimeout(context.Background(), openCodeListTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "session", "list", "--format", "json")
	cmd.Dir = workDir
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	return openCodeListHas(out, id)
}

// openCodeListHas reports whether `opencode session list --format json`
// output lists session id.
func openCodeListHas(out []byte, id string) bool {
	var sessions []struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(out, &sessions) != nil {
		return false
	}
	for _, s := range sessions {
		if s.ID == id {
			return true
		}
	}
	return false
}

// ResumeArgs puts --session before the one-shot prompt:
// `pi --session <id> … -p <reply>`. --session reopens an existing session;
// --session-id would silently create an empty one when it is missing.
func (p *Pi) ResumeArgs(args []string, id string) []string {
	return append([]string{"--session", id}, args...)
}

// piSessionDir is where Pi keeps sessions: $PI_CODING_AGENT_SESSION_DIR, else
// $PI_CODING_AGENT_DIR/sessions, else ~/.pi/agent/sessions.
func piSessionDir() string {
	if v := os.Getenv("PI_CODING_AGENT_SESSION_DIR"); v != "" {
		return v
	}
	if root := homeDir("PI_CODING_AGENT_DIR", filepath.Join(".pi", "agent")); root != "" {
		return filepath.Join(root, "sessions")
	}
	return ""
}

// CanResume looks for <sessions>/<encoded cwd>/<timestamp>_<id>.jsonl whose
// header records workDir as its cwd. Resumed from another directory, Pi asks
// "Fork this session into current directory? [y/N]" and, with no terminal,
// exits 0 without running the turn.
func (p *Pi) CanResume(_, workDir, id string) bool {
	dir := piSessionDir()
	if !ValidResumeID(id) || dir == "" {
		return false
	}
	for _, pattern := range []string{filepath.Join(dir, "*", "*_"+id+".jsonl"), filepath.Join(dir, "*_"+id+".jsonl")} {
		matches, _ := filepath.Glob(pattern)
		for _, m := range matches {
			if samePath(piSessionCwd(m), workDir) {
				return true
			}
		}
	}
	return false
}

// piSessionCwd is the cwd in a Pi session file's header line.
func piSessionCwd(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	line, _ := bufio.NewReader(f).ReadBytes('\n')
	var header struct {
		Type string `json:"type"`
		Cwd  string `json:"cwd"`
	}
	if json.Unmarshal(bytes.TrimSpace(line), &header) != nil || header.Type != "session" {
		return ""
	}
	return header.Cwd
}

// samePath compares two directories after resolving symlinks (/tmp vs /private/tmp).
func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	resolve := func(p string) string {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return filepath.Clean(r)
		}
		return filepath.Clean(p)
	}
	return resolve(a) == resolve(b)
}

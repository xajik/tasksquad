// Package dreamer implements Dreaming: a nightly, per-project background job
// that reads a project's daily Memory rollup and makes small, targeted edits
// to its git-tracked knowledge base (tsq/kb/, see packages/daemon/kb),
// committing and pushing the result. It also owns the one-time `tsq kb init`
// bootstrap (RunInit) that a user runs to create tsq/kb/ in the first place —
// both call sites share the same tmux print-mode spawning mechanics (see
// spawn.go), which is why they live in one package rather than three.
//
// Dreaming never touches a live task prompt — it only writes tsq/kb/ files in
// the background. The "knowledge base available" note agents see in their
// prompts (agent/lifecycle.go's injectKBNote) is a separate, independent
// mechanism that just checks whether tsq/kb/ happens to be populated; it has
// no awareness of Dreaming and would fire identically if tsq/kb/ had been
// populated by `tsq kb init` alone with Dreaming disabled.
package dreamer

import (
	"fmt"
	"hash/fnv"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/kb"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/tmux"
)

const (
	// monitorInterval is how often Dreamer.Monitor re-checks every agent —
	// no single check needs to be prompt (the trigger time itself is random
	// within a multi-hour window), so this is coarser than Supervisor's
	// checkInterval.
	monitorInterval = 10 * time.Minute

	// sessionCheckInterval is how often the nightly Dreaming session is
	// polled for exit — no verdict channel exists for it to push through
	// (there's no task ID to report a verdict against), so polling is the
	// only signal available.
	sessionCheckInterval = 10 * time.Second

	// sessionTimeout bounds how long a single Dreaming session may run
	// before it's killed and counted as a (still marker-recorded) failure
	// for the night.
	sessionTimeout = 15 * time.Minute

	defaultWindowStart = "01:00"
	defaultWindowEnd   = "05:00"
)

// DreamAgent is the minimal interface Dreamer.Monitor needs from each
// configured agent — mirrors supervisor.MonitoredAgent's shape for the same
// daemon-side agent list. *agent.Agent already implements this via its
// existing AgentID/WorkDir/Name accessors (packages/daemon/agent/agent.go).
type DreamAgent interface {
	AgentID() string
	WorkDir() string
	Name() string
}

// Dreamer runs the nightly Dreaming cycle for a fleet of configured agents.
type Dreamer struct {
	cfg     *config.Config
	cli     string
	fullCmd string
}

// New creates a Dreamer. If neither [dreamer] nor [supervisor] configures a
// usable CLI, Dreaming is disabled (cli == "") and Monitor becomes a no-op.
func New(cfg *config.Config) *Dreamer {
	cli, fullCmd := resolveDreamerCLI(cfg)
	return &Dreamer{cfg: cfg, cli: cli, fullCmd: fullCmd}
}

// Monitor watches agents in a loop and runs the nightly Dreaming cycle for
// each once its random per-project trigger time arrives. Blocks forever; run
// in a goroutine. token authenticates the /daemon/dream/claim and
// /daemon/memory/rollup calls — same Firebase ID token main.go already
// resolves for orphan.New.
func (d *Dreamer) Monitor(agents []DreamAgent, token string) {
	if d.cli == "" {
		logger.Warn("[dreamer] No CLI available — Dreaming monitor not started")
		return
	}
	if token == "" {
		logger.Warn("[dreamer] No auth token — Dreaming monitor not started")
		return
	}
	logger.Info(fmt.Sprintf("[dreamer] Monitor started (cli=%s, interval=%s)", d.cli, monitorInterval))

	ticker := time.NewTicker(monitorInterval)
	defer ticker.Stop()

	for range ticker.C {
		for _, a := range agents {
			d.maybeDream(a, token)
		}
	}
}

// maybeDream runs the eligibility checks for one agent and, if this is the
// night's chosen moment and this daemon wins the cross-machine claim, spawns
// a Dreaming session for it.
func (d *Dreamer) maybeDream(a DreamAgent, token string) {
	workDir := a.WorkDir()
	agentID := a.AgentID()
	today := time.Now().Format("2006-01-02")

	if !kb.Exists(workDir) {
		return // Dreaming never auto-bootstraps; only `tsq kb init` creates tsq/kb.
	}
	if hasRunToday(agentID, today) {
		return
	}
	if time.Now().Before(triggerTime(agentID, today, d.windowStart(), d.windowEnd())) {
		return // not this agent's random moment yet — try again next tick
	}

	projectKey, err := resolveProjectKey(workDir)
	if err != nil || projectKey == "" {
		logger.Info(fmt.Sprintf("[dreamer] %s: no git remote — skipping Dreaming", a.Name()))
		return
	}

	claimed, err := d.claim(token, agentID, projectKey, today)
	if err != nil {
		logger.Warn(fmt.Sprintf("[dreamer] %s: claim request failed: %v", a.Name(), err))
		return // transient failure — retry on a later tick tonight
	}
	if !claimed {
		logger.Info(fmt.Sprintf("[dreamer] %s: another daemon already claimed tonight's Dreaming for %s", a.Name(), projectKey))
		return
	}
	logger.Info(fmt.Sprintf("[dreamer] %s: claimed tonight's Dreaming run for %s", a.Name(), projectKey))

	rollup, err := d.fetchRollup(token, agentID)
	if err != nil {
		logger.Warn(fmt.Sprintf("[dreamer] %s: failed to fetch memory rollup, proceeding with an empty one: %v", a.Name(), err))
	}

	// From here on, this daemon owns tonight's run for this project — the
	// marker is written once we've attempted it, regardless of how the
	// session itself turns out, so a failed/timed-out run doesn't
	// retry-loop for the rest of the night.
	d.runDreamSession(a, workDir, projectKey, rollup)
	writeLastRun(agentID, today)
}

func (d *Dreamer) windowStart() string {
	if d.cfg.Dreamer != nil && d.cfg.Dreamer.WindowStart != "" {
		return d.cfg.Dreamer.WindowStart
	}
	return defaultWindowStart
}

func (d *Dreamer) windowEnd() string {
	if d.cfg.Dreamer != nil && d.cfg.Dreamer.WindowEnd != "" {
		return d.cfg.Dreamer.WindowEnd
	}
	return defaultWindowEnd
}

// claim calls POST /daemon/dream/claim, returning whether this daemon won
// the night's claim for projectKey. Response shape: {"claimed": bool}.
func (d *Dreamer) claim(token, agentID, projectKey, date string) (bool, error) {
	resp, err := api.Post(d.cfg, token, agentID, "/daemon/dream/claim", map[string]any{
		"project_key": projectKey,
		"date":        date,
	})
	if err != nil {
		return false, err
	}
	claimed, _ := resp["claimed"].(bool)
	return claimed, nil
}

// fetchRollup calls GET /daemon/memory/rollup?period=daily, returning the
// content of today's daily Memory rollup. Response shape: {"content": string}.
func (d *Dreamer) fetchRollup(token, agentID string) (string, error) {
	resp, err := api.GetWithAgent(d.cfg, token, agentID, "/daemon/memory/rollup?period=daily")
	if err != nil {
		return "", err
	}
	content, _ := resp["content"].(string)
	return content, nil
}

// runDreamSession spawns the nightly print-mode session loading
// /tsq-dreaming and blocks (polling) until it exits or times out.
func (d *Dreamer) runDreamSession(a DreamAgent, workDir, projectKey, rollup string) {
	id := shortID()
	sessionName, err := safeSessionName("tsq-dream-", id)
	if err != nil {
		logger.Error(fmt.Sprintf("[dreamer] %s: %v", a.Name(), err))
		return
	}
	logPath := dreamerLogPath("dream-" + id)

	logger.Info(fmt.Sprintf("[dreamer] %s: starting Dreaming session %s for %s", a.Name(), sessionName, projectKey))
	if err := spawnPrintModeSession(d.cli, d.fullCmd, sessionName, workDir, buildDreamPrompt(workDir, projectKey, rollup), logPath); err != nil {
		logger.Error(fmt.Sprintf("[dreamer] %s: failed to start Dreaming session: %v", a.Name(), err))
		return
	}

	outcome := waitForSessionExit(sessionName, sessionTimeout)
	logger.Info(fmt.Sprintf("[dreamer] %s: Dreaming session %s finished (%s) — log: %s", a.Name(), sessionName, outcome, logPath))
}

// buildDreamPrompt builds the initial message sent to the Dreaming CLI.
func buildDreamPrompt(workDir, projectKey, rollup string) string {
	if rollup == "" {
		rollup = "(no memory activity recorded today)"
	}
	return fmt.Sprintf(
		`You are TaskSquad Dreaming: a nightly background job that keeps a project's git-tracked knowledge base in sync with today's Memory activity.

Working directory: %s
Project key:       %s

Today's memory rollup:
%s

Load /tsq-dreaming and follow its instructions: walk the rollup above fact-by-fact, make small targeted edits to the relevant tsq/kb/*.md file(s), then commit and push.`,
		workDir, projectKey, rollup,
	)
}

// waitForSessionExit polls tmux has-session until the print-mode session
// exits (self-terminates when the CLI finishes) or timeout elapses, killing
// it in the timeout case. Mirrors supervisor.waitForVerdictOrKill's polling
// shape, minus the verdict channel — no task ID exists for this session to
// report a verdict against; the tsq-dreaming skill's own `tsq memory push`
// call at the end is the durable record of what happened.
func waitForSessionExit(sessionName string, timeout time.Duration) string {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(sessionCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-deadline.C:
			tmux.KillSession(sessionName) //nolint:errcheck
			return "timeout"
		case <-ticker.C:
			if !tmux.HasSession(sessionName) {
				return "exited"
			}
		}
	}
}

// triggerTime computes a stable per-project random instant within
// [windowStart, windowEnd) for the given agentID and date, seeding
// math/rand with an FNV-1a hash of agentID+date. The same (agentID, date)
// pair always yields the same instant regardless of how many times this is
// called or how many times the daemon restarts during that day — so a
// restart mid-night can't double-fire or reroll into a new random slot.
func triggerTime(agentID, date, windowStart, windowEnd string) time.Time {
	start := parseClock(windowStart, defaultWindowStart)
	end := parseClock(windowEnd, defaultWindowEnd)

	day, err := time.ParseInLocation("2006-01-02", date, time.Local)
	if err != nil {
		day = time.Now()
	}
	base := time.Date(day.Year(), day.Month(), day.Day(), start.Hour(), start.Minute(), 0, 0, time.Local)

	windowSeconds := int(end.Sub(start).Seconds())
	if windowSeconds <= 0 {
		windowSeconds = int((24*time.Hour + end.Sub(start)).Seconds()) // window wraps past midnight
	}
	if windowSeconds <= 0 {
		windowSeconds = 1
	}

	h := fnv.New64a()
	h.Write([]byte(agentID + date)) //nolint:errcheck
	rng := rand.New(rand.NewSource(int64(h.Sum64())))
	offset := time.Duration(rng.Intn(windowSeconds)) * time.Second

	return base.Add(offset)
}

// parseClock parses an "HH:MM" string, falling back to fallback (also
// "HH:MM") if value is empty or malformed. Only Hour()/Minute() of the
// returned time are meaningful.
func parseClock(value, fallback string) time.Time {
	if t, err := time.Parse("15:04", value); err == nil {
		return t
	}
	t, _ := time.Parse("15:04", fallback)
	return t
}

// resolveProjectKey runs `git -C workDir remote get-url origin` and
// normalizes the result into a stable cross-machine key: trimmed, ".git"
// suffix stripped, lowercased. Returns ("", nil) if the project has no git
// remote — nothing meaningful to push to, and no stable key to claim
// against, so the caller skips Dreaming for it entirely.
func resolveProjectKey(workDir string) (string, error) {
	out, err := exec.Command("git", "-C", workDir, "remote", "get-url", "origin").Output()
	if err != nil {
		return "", nil //nolint:nilerr // no remote configured is an expected, not exceptional, outcome
	}
	key := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(string(out)), ".git"))
	return key, nil
}

// dreamerStateDir returns ~/.tasksquad/dreamer/<agentID>/, where the
// last-run marker for agentID lives.
func dreamerStateDir(agentID string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".tasksquad", "dreamer", agentID)
}

// hasRunToday reports whether the last-run marker for agentID already
// records today's date.
func hasRunToday(agentID, today string) bool {
	data, err := os.ReadFile(filepath.Join(dreamerStateDir(agentID), "last-run"))
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(data)) == today
}

// writeLastRun records today's date as the last Dreaming attempt for
// agentID, so maybeDream won't retry the same project again tonight
// regardless of whether the attempt succeeded.
func writeLastRun(agentID, today string) {
	dir := dreamerStateDir(agentID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		logger.Warn(fmt.Sprintf("[dreamer] failed to create state dir %s: %v", dir, err))
		return
	}
	if err := os.WriteFile(filepath.Join(dir, "last-run"), []byte(today), 0644); err != nil {
		logger.Warn(fmt.Sprintf("[dreamer] failed to write last-run marker: %v", err))
	}
}

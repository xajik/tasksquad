package supervisor

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/tmux"
)

const inactivityTimeout = 10 * time.Minute
const checkInterval = 60 * time.Second

const (
	// supervisorTimeout is how long a supervisor session may run before it is
	// killed and the attempt is retried on the next inactivity cycle.
	supervisorTimeout = 5 * time.Minute

	// orphanCleanupInterval is how often the supervisor scans for dangling
	// tsq-sup-* tmux sessions that survived previous daemon runs or crashes.
	orphanCleanupInterval = 12 * time.Hour

	// sessionCheckInterval is how often waitForVerdictOrKill polls whether the
	// supervisor tmux session is still alive (print-mode self-termination).
	sessionCheckInterval = 5 * time.Second

	// maxSupervisorFailures is the number of consecutive no-verdict attempts before
	// the supervisor sends an escalation message to the task thread.
	maxSupervisorFailures = 5
)

// VerdictStatus is the typed verdict reported by the supervisor agent.
type VerdictStatus string

const (
	VerdictWorkingFine VerdictStatus = "working_fine"
	VerdictResolved    VerdictStatus = "resolved"
	VerdictCannotHelp  VerdictStatus = "cannot_help"
)

// supervisorVerdict is the payload sent by the supervisor agent via POST /hooks/supervisor.
type supervisorVerdict struct {
	Status  VerdictStatus `json:"status"`
	Summary string        `json:"summary"`
	Found   string        `json:"found"`
	Action  string        `json:"action"`
}

// MonitoredAgent is the interface the supervisor requires from each agent.
type MonitoredAgent interface {
	Name() string
	AgentID() string
	GetMode() string
	GetTaskID() string
	TmuxSession() string
	WorkDir() string
	LastLogPath() string
	GetLastActivityAt() time.Time
}

// Supervisor monitors all agents and spawns a dedicated tmux session when a
// running task has had no hook activity for inactivityTimeout.
type Supervisor struct {
	mu            sync.Mutex
	activeForTask map[string]bool
	lastAttempt   map[string]time.Time             // when supervision was last attempted per taskID
	failCount     map[string]int                   // consecutive no-verdict attempts per taskID
	verdictChans  map[string]chan supervisorVerdict // taskID → verdict delivery channel
	cli           string                           // resolved CLI binary path (empty = disabled)
	fullCmd       string                           // full command string with flags from [supervisor] config
	daemonBinDir  string                           // directory containing the tsq binary; prepended to PATH in supervisor sessions
	cfg           *config.Config
	agents        []MonitoredAgent // populated by Monitor; used by TriggerForTask
}

// New creates a Supervisor. If the [supervisor] section is absent from config
// or the binary cannot be found in PATH, the supervisor is disabled (cli == "").
func New(cfg *config.Config) *Supervisor {
	binDir := ""
	if exe, err := os.Executable(); err == nil {
		binDir = filepath.Dir(exe)
	}
	cli, fullCmd := "", ""
	if cfg.Supervisor != nil {
		cli, fullCmd = resolveSupervisorCLI(cfg.Supervisor)
	} else {
		logger.Info("[supervisor] No [supervisor] section in config — supervisor disabled")
	}
	return &Supervisor{
		activeForTask: make(map[string]bool),
		lastAttempt:   make(map[string]time.Time),
		failCount:     make(map[string]int),
		verdictChans:  make(map[string]chan supervisorVerdict),
		cli:           cli,
		fullCmd:       fullCmd,
		daemonBinDir:  binDir,
		cfg:           cfg,
	}
}

// HandleVerdict receives a supervisor verdict from POST /hooks/supervisor and
// delivers it to the waiting spawn() goroutine via its channel.
// Holds the mutex for the full operation to avoid a TOCTOU race between
// checking the channel exists and sending on it.
func (s *Supervisor) HandleVerdict(taskID, status, summary, found, action string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch, ok := s.verdictChans[taskID]
	if !ok {
		logger.Warn(fmt.Sprintf("[supervisor] HandleVerdict: no active session for task %s (already done or unknown)", taskID))
		return
	}
	select {
	case ch <- supervisorVerdict{Status: VerdictStatus(status), Summary: summary, Found: found, Action: action}:
		logger.Info(fmt.Sprintf("[supervisor] Verdict received for task %s: status=%s", taskID, status))
	default:
		logger.Warn(fmt.Sprintf("[supervisor] HandleVerdict: duplicate verdict for task %s — ignoring", taskID))
	}
}

// CancelForTask kills any active supervisor session for the given task.
// Called when the monitored agent's Stop hook fires (task is completing normally).
func (s *Supervisor) CancelForTask(taskID string) {
	if taskID == "" {
		return
	}
	suffix := taskID
	if len(suffix) > 8 {
		suffix = suffix[:8]
	}
	sessionName := "tsq-sup-" + suffix
	if tmux.HasSession(sessionName) {
		logKill(sessionName, tmux.KillSession(sessionName))
		logger.Info(fmt.Sprintf("[supervisor] CancelForTask: killed %s (agent stop received for task %s)", sessionName, taskID))
	}
	s.mu.Lock()
	delete(s.activeForTask, taskID)
	delete(s.failCount, taskID)
	s.mu.Unlock()
}

// TriggerForTask immediately spawns a supervisor session for the given task,
// regardless of inactivity timeout. Returns an error if the supervisor is
// disabled, already active for the task, or no agent is running that task.
func (s *Supervisor) TriggerForTask(taskID string) error {
	if s.cli == "" {
		return fmt.Errorf("supervisor disabled — no CLI configured")
	}
	s.mu.Lock()
	if s.activeForTask[taskID] {
		s.mu.Unlock()
		return fmt.Errorf("supervisor already active for task %s", taskID)
	}
	var target MonitoredAgent
	for _, a := range s.agents {
		if a.GetTaskID() == taskID {
			target = a
			break
		}
	}
	if target == nil {
		s.mu.Unlock()
		return fmt.Errorf("no agent currently running task %s", taskID)
	}
	s.activeForTask[taskID] = true
	s.lastAttempt[taskID] = time.Now()
	s.mu.Unlock()
	logger.Info(fmt.Sprintf("[supervisor] Manual trigger for task %s (agent=%s)", taskID, target.Name()))
	go s.spawn(target, taskID)
	return nil
}

// Monitor watches agents in a loop and spawns supervisor sessions for inactive tasks.
// Blocks forever; run in a goroutine.
func (s *Supervisor) Monitor(agents []MonitoredAgent) {
	s.mu.Lock()
	s.agents = agents
	s.mu.Unlock()

	if s.cli == "" {
		logger.Warn("[supervisor] No CLI available — monitor not started")
		return
	}
	logger.Info(fmt.Sprintf("[supervisor] Monitor started (cli=%s, timeout=%s)", s.cli, inactivityTimeout))

	// Kill any tsq-sup-* sessions left over from a previous daemon run.
	s.cleanOrphans()

	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()
	orphanTicker := time.NewTicker(orphanCleanupInterval)
	defer orphanTicker.Stop()

	for {
		select {
		case <-ticker.C:
			for _, a := range agents {
				mode := a.GetMode()
				if mode != "running" && mode != "wrapping_up" {
					continue
				}
				taskID := a.GetTaskID()
				if taskID == "" {
					continue
				}
				// Only supervise agents running via tmux; stdout-pipe providers
				// (e.g. codex) have no session to inspect or send keys to.
				if a.TmuxSession() == "" {
					continue
				}
				s.mu.Lock()
				active := s.activeForTask[taskID]
				last := s.lastAttempt[taskID]
				s.mu.Unlock()
				if active {
					continue
				}
				// Cooldown: don't re-attempt until inactivityTimeout after the last attempt.
				if !last.IsZero() && time.Since(last) < inactivityTimeout {
					continue
				}
				lastActivity := a.GetLastActivityAt()
				if lastActivity.IsZero() || time.Since(lastActivity) < inactivityTimeout {
					continue
				}
				logger.Info(fmt.Sprintf("[supervisor] Agent %q task %s inactive >%s — spawning supervisor",
					a.Name(), taskID, inactivityTimeout))
				s.mu.Lock()
				s.activeForTask[taskID] = true
				s.lastAttempt[taskID] = time.Now()
				s.mu.Unlock()
				go s.spawn(a, taskID)
			}
		case <-orphanTicker.C:
			s.cleanOrphans()
		}
	}
}

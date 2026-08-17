package speechtomd

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/provider"
	"github.com/tasksquad/daemon/tmux"
)

const (
	tmuxSessionPrefix    = "tsq-stm-"
	tmuxAgentInitTimeout = 90 * time.Second
	tmuxResultTimeout    = 5 * time.Minute
)

// tmuxAgent manages the persistent tmux session for speech-to-md chunk processing.
// It implements ChunkAgent (synchronous Complete that blocks until the hook delivers
// the result) and HookNotifiable (MarkInitialized + DeliverResult called by the
// Manager when hook callbacks arrive).
type tmuxAgent struct {
	mu             sync.Mutex
	tmuxName       string
	agentCfg       config.AgentConfig
	hooksPort      int
	sessionDir     string
	promptOverride string
	initialized    bool
	initCh         chan struct{}
	stopOnce       sync.Once
	stopCh         chan struct{}
	pendingMu      sync.Mutex
	pending        chan string // unblocked by DeliverResult from hook callback
}

func newTmuxAgent(agentCfg config.AgentConfig, hooksPort int, sessionDir, promptOverride string) *tmuxAgent {
	return &tmuxAgent{
		agentCfg:       agentCfg,
		hooksPort:      hooksPort,
		sessionDir:     sessionDir,
		promptOverride: promptOverride,
		initCh:         make(chan struct{}),
		stopCh:         make(chan struct{}),
	}
}

// TmuxName returns the tmux session name.
func (a *tmuxAgent) TmuxName() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.tmuxName
}

// Start spawns the tmux session, sends the init command, and blocks until the
// agent fires the init hook (or the 90 s timeout elapses).
func (a *tmuxAgent) Start() error {
	workDir := a.agentCfg.WorkDir
	if workDir == "" {
		workDir = a.sessionDir
	}

	prov := provider.Detect(a.agentCfg.Command, a.agentCfg.Provider)
	if err := prov.SetupVoice(workDir, a.hooksPort); err != nil {
		if errors.Is(err, provider.ErrNotSupported) {
			logger.Warn(fmt.Sprintf("[speech-agent] provider %s does not support voice hooks", prov.Name()))
		} else {
			logger.Warn(fmt.Sprintf("[speech-agent] provider setup: %v", err))
		}
	}

	ts := fmt.Sprintf("%d", time.Now().UnixMilli())
	sessionName := tmuxSessionPrefix + ts[:8]

	cmd := a.agentCfg.Command
	if cmd == "" {
		cmd = "claude"
	}
	if extra := prov.VoiceCLIArg(); extra != "" {
		cmd += " " + extra
	}
	// Providers that support scoping hook config to this exact invocation
	// (e.g. Claude Code's --settings flag) return args via this optional
	// interface instead of SetupVoice writing into the shared workDir file.
	if vp, ok := prov.(interface{ VoiceSetupArgs(int) []string }); ok {
		for _, arg := range vp.VoiceSetupArgs(a.hooksPort) {
			cmd += fmt.Sprintf(" '%s'", arg)
		}
	}

	newArgs := append([]string{
		"new-session", "-d", "-s", sessionName,
		"-c", workDir, "--",
	}, cmd)
	tmuxCmd := exec.Command("tmux", newArgs...)
	tmuxCmd.Env = append(os.Environ(),
		fmt.Sprintf("TSQ_HOOKS_PORT=%d", a.hooksPort),
	)
	if out, err := tmuxCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux new-session: %w (output: %s)", err, out)
	}

	a.mu.Lock()
	a.tmuxName = sessionName
	a.mu.Unlock()

	logger.Info(fmt.Sprintf("[speech-agent] Session %s spawned in %s; waiting for CLI to load (%s)", sessionName, workDir, tmux.SessionReadyWait))
	tmux.WaitForReady()

	if a.promptOverride != "" {
		initFile, err := os.CreateTemp("", "tsq-speech-init-*.md")
		if err != nil {
			return fmt.Errorf("create init temp: %w", err)
		}
		defer os.Remove(initFile.Name())
		if _, err := initFile.WriteString(a.promptOverride); err != nil {
			initFile.Close()
			return fmt.Errorf("write init temp: %w", err)
		}
		initFile.Close()
		bufName := fmt.Sprintf("speech-init-%s", sessionName)
		if err := tmux.PastePromptFile(sessionName, bufName, initFile.Name()); err != nil {
			return fmt.Errorf("tmux paste init: %w", err)
		}
		tmux.DeleteBuffer(bufName)
		logger.Info(fmt.Sprintf("[speech-agent] Sent custom prompt to %s; awaiting ready", sessionName))
	} else {
		initCmd := prov.VoiceInitCommand()
		if err := tmux.SendKeys(sessionName, initCmd); err != nil {
			return fmt.Errorf("tmux send %s: %w", initCmd, err)
		}
		if prov.VoiceCLIArg() != "" {
			if err := tmux.SendKeys(sessionName, "C-n"); err != nil {
				return fmt.Errorf("tmux send C-n: %w", err)
			}
		}
		logger.Info(fmt.Sprintf("[speech-agent] Sent %s to %s; awaiting ready", initCmd, sessionName))
	}

	logger.Info(fmt.Sprintf("[speech-agent] %s waiting for ready signal (timeout: %s)", sessionName, tmuxAgentInitTimeout))
	t := time.NewTimer(tmuxAgentInitTimeout)
	defer t.Stop()
	select {
	case <-a.initCh:
		logger.Info(fmt.Sprintf("[speech-agent] %s ready!", sessionName))
		return nil
	case <-t.C:
		return fmt.Errorf("agent init timed out after %s — run: tmux kill-session -t %s", tmuxAgentInitTimeout, sessionName)
	case <-a.stopCh:
		return fmt.Errorf("agent stopped before init")
	}
}

// MarkInitialized signals that the agent is ready; called via HookNotifiable when
// the init hook fires.
func (a *tmuxAgent) MarkInitialized() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.initialized {
		a.initialized = true
		close(a.initCh)
	}
}

// Complete sends transcript text to the tmux session and blocks until the hook
// callback delivers the markdown result (or the agent is stopped).
func (a *tmuxAgent) Complete(currentMD, transcript string, editMode bool) (string, error) {
	ch := make(chan string, 1)
	a.pendingMu.Lock()
	a.pending = ch
	a.pendingMu.Unlock()

	sessionName := a.TmuxName()
	logger.Info(fmt.Sprintf("[speech-agent] %s → sending chunk (%d words)", sessionName, len(strings.Fields(transcript))))

	if err := a.sendChunk(withModePrefix(Batch{Text: transcript, EditMode: editMode})); err != nil {
		a.pendingMu.Lock()
		a.pending = nil
		a.pendingMu.Unlock()
		return "", err
	}

	t := time.NewTimer(tmuxResultTimeout)
	defer t.Stop()
	select {
	case markdown := <-ch:
		logger.Info(fmt.Sprintf("[speech-agent] %s ← result received (%d chars)", sessionName, len(markdown)))
		return markdown, nil
	case <-t.C:
		logger.Warn(fmt.Sprintf("[speech-agent] %s result timed out after %s — will retry next cycle", sessionName, tmuxResultTimeout))
		return "", errAgentTimeout
	case <-a.stopCh:
		return "", fmt.Errorf("agent stopped")
	}
}

// DeliverResult delivers the hook result to the blocked Complete call; called via
// HookNotifiable when the agent's turn-complete hook fires.
func (a *tmuxAgent) DeliverResult(markdown string) {
	a.pendingMu.Lock()
	ch := a.pending
	a.pending = nil
	a.pendingMu.Unlock()
	if ch != nil {
		ch <- markdown
	}
}

func (a *tmuxAgent) sendChunk(text string) error {
	a.mu.Lock()
	sessionName := a.tmuxName
	a.mu.Unlock()
	if sessionName == "" {
		return fmt.Errorf("agent session not started")
	}

	f, err := os.CreateTemp("", "tsq-speech-chunk-*.txt")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString(text); err != nil {
		f.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	f.Close()

	bufName := fmt.Sprintf("speech-%s", sessionName)
	if err := tmux.PastePromptFile(sessionName, bufName, f.Name()); err != nil {
		return fmt.Errorf("paste chunk: %w", err)
	}
	tmux.DeleteBuffer(bufName)
	return nil
}

func withModePrefix(b Batch) string {
	if b.EditMode {
		return "[Mode: edit]\n" + b.Text
	}
	return "[Mode: append]\n" + b.Text
}

func (a *tmuxAgent) Stop() {
	a.mu.Lock()
	name := a.tmuxName
	a.tmuxName = ""
	a.mu.Unlock()

	a.stopOnce.Do(func() {
		close(a.stopCh)
		if name != "" {
			tmux.KillSession(name) //nolint:errcheck
			logger.Info(fmt.Sprintf("[speech-agent] Session %s killed", name))
		}
	})
}

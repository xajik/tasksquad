package speechtomd

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/provider"
	"github.com/tasksquad/daemon/tmux"
)

const tmuxSessionPrefix = "tsq-stm-"

// AgentSession manages the persistent tmux session for speech-to-md chunk processing.
type AgentSession struct {
	mu             sync.Mutex
	tmuxName       string
	agentCfg       config.AgentConfig
	hooksPort      int
	sessionDir     string
	promptOverride string
	initialized    bool
	initCh         chan struct{}
	stopped        bool
}

// TmuxName returns the tmux session name.
func (s *AgentSession) TmuxName() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tmuxName
}


func newAgentSession(agentCfg config.AgentConfig, hooksPort int, sessionDir, promptOverride string) *AgentSession {
	return &AgentSession{
		agentCfg:       agentCfg,
		hooksPort:      hooksPort,
		sessionDir:     sessionDir,
		promptOverride: promptOverride,
		initCh:         make(chan struct{}),
	}
}

// Start spawns the agent's tmux session, waits for it to load, then sends
// either /tsq-speech-to-md (default) or the user's custom prompt.
func (s *AgentSession) Start() error {
	workDir := s.agentCfg.WorkDir
	if workDir == "" {
		workDir = s.sessionDir
	}

	prov := provider.Detect(s.agentCfg.Command, s.agentCfg.Provider)
	if err := prov.SetupVoice(workDir, s.hooksPort); err != nil {
		if errors.Is(err, provider.ErrNotSupported) {
			logger.Warn(fmt.Sprintf("[speech-agent] provider %s does not support voice hooks", prov.Name()))
		} else {
			logger.Warn(fmt.Sprintf("[speech-agent] provider setup: %v", err))
		}
	}

	ts := fmt.Sprintf("%d", time.Now().UnixMilli())
	sessionName := tmuxSessionPrefix + ts[:8]

	cmd := s.agentCfg.Command
	if cmd == "" {
		cmd = "claude"
	}

	newArgs := append([]string{
		"new-session", "-d", "-s", sessionName,
		"-c", workDir, "--",
	}, cmd)
	tmuxCmd := exec.Command("tmux", newArgs...)
	tmuxCmd.Env = append(os.Environ(),
		fmt.Sprintf("TSQ_HOOKS_PORT=%d", s.hooksPort),
	)
	if out, err := tmuxCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux new-session: %w (output: %s)", err, out)
	}

	s.mu.Lock()
	s.tmuxName = sessionName
	s.mu.Unlock()

	logger.Info(fmt.Sprintf("[speech-agent] Session %s spawned in %s; waiting for CLI to load (%s)", sessionName, workDir, tmux.SessionReadyWait))
	tmux.WaitForReady()

	if s.promptOverride != "" {
		// Custom prompt: paste via temp file so it handles multi-line content.
		initFile, err := os.CreateTemp("", "tsq-speech-init-*.md")
		if err != nil {
			return fmt.Errorf("create init temp: %w", err)
		}
		defer os.Remove(initFile.Name())
		if _, err := initFile.WriteString(s.promptOverride); err != nil {
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
		// Default: invoke the pre-installed @tsq-speech-to-md slash command.
		if err := tmux.SendKeys(sessionName, "@tsq-speech-to-md"); err != nil {
			return fmt.Errorf("tmux send @tsq-speech-to-md: %w", err)
		}
		logger.Info(fmt.Sprintf("[speech-agent] Sent @tsq-speech-to-md to %s; awaiting ready", sessionName))
	}

	return nil
}

// WaitForInit blocks until the agent fires the init hook, or times out.
func (s *AgentSession) WaitForInit(timeout time.Duration) error {
	logger.Info(fmt.Sprintf("[speech-agent] %s waiting for ready signal (timeout: %s)", s.tmuxName, timeout))
	select {
	case <-s.initCh:
		logger.Info(fmt.Sprintf("[speech-agent] %s ready!", s.tmuxName))
		return nil
	case <-time.After(timeout):
		logger.Warn(fmt.Sprintf("[speech-agent] %s init timeout after %s", s.tmuxName, timeout))
		return fmt.Errorf("agent init timed out after %s", timeout)
	}
}

// MarkInitialized is called by the hook server when the init hook fires.
func (s *AgentSession) MarkInitialized() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized {
		s.initialized = true
		close(s.initCh)
	}
}

// SendChunk writes the transcript text to a temp file and pastes it into the tmux session.
func (s *AgentSession) SendChunk(text string) error {
	s.mu.Lock()
	sessionName := s.tmuxName
	s.mu.Unlock()
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

// Stop kills the tmux session.
func (s *AgentSession) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tmuxName == "" || s.stopped {
		return
	}
	s.stopped = true
	tmux.KillSession(s.tmuxName) //nolint:errcheck
	logger.Info(fmt.Sprintf("[speech-agent] Session %s killed", s.tmuxName))
	s.tmuxName = ""
}

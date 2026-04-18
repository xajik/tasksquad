package voicetomd

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/harness"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/provider"
	"github.com/tasksquad/daemon/tmux"
)

const tmuxSessionPrefix = "tsq-vtm-"

// commandFileContent is installed to every harness commands directory so any CLI
// can invoke /tsq-voice-to-md manually. PORT and NOTES_PATH are replaced before
// writing (NOTES_PATH becomes a shell expression for dynamic sessions).
const commandFileContent = `You are a voice-to-markdown transcription assistant running inside a TaskSquad voice session.

**Initialization**
Signal readiness to the daemon immediately by running this bash command:
` + "```" + `bash
curl -s -X POST http://localhost:PORT/hooks/voice-to-md/init \
  -H 'Content-Type: application/json' \
  -d '{"status":"ready"}'
` + "```" + `

**Processing chunks**
Your notes file is: NOTES_PATH

For each user message you receive (a JSON object with "current_markdown" and "new_transcript"):

1. Clean the transcript: remove filler words (um, uh, like, you know, so, actually, basically), fix grammar, compress verbose phrasing.
2. Preserve all technical terms, names, numbers, and code identifiers exactly as spoken.
3. Integrate the cleaned text into current_markdown — do NOT rewrite or reformat existing sections.
4. Write the complete updated markdown to NOTES_PATH (create or overwrite).
5. Post the result to the daemon:
` + "```" + `bash
cat << 'EOF' | jq -Rs '{markdown:.}' | curl -s -X POST http://localhost:PORT/hooks/voice-to-md/response -H 'Content-Type: application/json' -d @-
<your updated markdown here>
EOF
` + "```" + `

Remain in this mode for the entire session, processing one chunk at a time.`

// subAgentContent is installed to every harness agents directory so any CLI
// can spawn tsq-voice-to-md as a sub-agent. PORT is replaced before writing.
const subAgentContent = `---
description: Voice-to-markdown transcription assistant for TaskSquad voice sessions. Processes audio transcript chunks and converts them to clean, structured markdown. Signals readiness and posts results to the TaskSquad daemon on port PORT.
---
` + commandFileContent

// AgentSession manages the persistent tmux session for voice-to-md chunk processing.
type AgentSession struct {
	mu          sync.Mutex
	tmuxName    string
	agentCfg    config.AgentConfig
	hooksPort   int
	sessionDir  string
	notesPath   string
	initialized bool
	initCh      chan struct{}
	stopped     bool
}

// ChunkPayload is the JSON sent to the agent for each transcript chunk.
type ChunkPayload struct {
	CurrentMarkdown string `json:"current_markdown"`
	NewTranscript   string `json:"new_transcript"`
}

func newAgentSession(agentCfg config.AgentConfig, hooksPort int, sessionDir string) *AgentSession {
	workDir := agentCfg.WorkDir
	if workDir == "" {
		workDir = sessionDir
	}
	ts := time.Now()
	notesDir := filepath.Join(workDir, ".tsq", "notes", ts.Format("20060102"))
	notesPath := filepath.Join(notesDir, ts.Format("150405")+".md")

	return &AgentSession{
		agentCfg:  agentCfg,
		hooksPort: hooksPort,
		sessionDir: sessionDir,
		notesPath: notesPath,
		initCh:    make(chan struct{}),
	}
}

// Start spawns the agent's tmux session, waits for it to load, then sends
// /tsq-voice-to-md using the same send-keys pattern as the regular task runner.
func (s *AgentSession) Start() error {
	if err := s.installBuiltins(); err != nil {
		logger.Warn(fmt.Sprintf("[voice-agent] install builtins: %v", err))
	}

	// Create the notes directory so the agent can write to the file immediately.
	if err := os.MkdirAll(filepath.Dir(s.notesPath), 0755); err != nil {
		logger.Warn(fmt.Sprintf("[voice-agent] create notes dir: %v", err))
	}

	// Write hooks to the agent's configured work directory — the same directory
	// the CLI runs from, so it picks up the settings.json.
	workDir := s.agentCfg.WorkDir
	if workDir == "" {
		workDir = s.sessionDir
	}
	prov := provider.Detect(s.agentCfg.Command, s.agentCfg.Provider)
	if err := prov.SetupVoice(workDir, s.hooksPort); err != nil {
		if errors.Is(err, provider.ErrNotSupported) {
			logger.Warn(fmt.Sprintf("[voice-agent] provider %s does not support voice hooks", prov.Name()))
		} else {
			logger.Warn(fmt.Sprintf("[voice-agent] provider setup: %v", err))
		}
	}

	ts := fmt.Sprintf("%d", time.Now().UnixMilli())
	sessionName := tmuxSessionPrefix + ts[:8]

	// Determine the binary to run.
	cmd := s.agentCfg.Command
	if cmd == "" {
		cmd = "claude"
	}

	// Spawn the tmux session in the agent's work directory so Claude Code finds
	// the .claude/settings.json hooks we just wrote.
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

	logger.Info(fmt.Sprintf("[voice-agent] Session %s spawned in %s; waiting for CLI to load (%s)", sessionName, workDir, tmux.SessionReadyWait))

	// Wait for the CLI to fully initialise before sending any keys.
	// This mirrors the exact timing used in agent/lifecycle.go.
	tmux.WaitForReady()

	// Send the init instructions directly as the first message using PastePromptFile —
	// the same mechanism used for chunk payloads, avoids any TUI slash-command issues.
	initContent := strings.ReplaceAll(commandFileContent, "PORT", fmt.Sprintf("%d", s.hooksPort))
	initContent = strings.ReplaceAll(initContent, "NOTES_PATH", s.notesPath)
	initFile, err := os.CreateTemp("", "tsq-voice-init-*.md")
	if err != nil {
		return fmt.Errorf("create init temp: %w", err)
	}
	defer os.Remove(initFile.Name())
	if _, err := initFile.WriteString(initContent); err != nil {
		initFile.Close()
		return fmt.Errorf("write init temp: %w", err)
	}
	initFile.Close()

	bufName := fmt.Sprintf("voice-init-%s", sessionName)
	if err := tmux.PastePromptFile(sessionName, bufName, initFile.Name()); err != nil {
		return fmt.Errorf("tmux paste init: %w", err)
	}
	tmux.DeleteBuffer(bufName)

	logger.Info(fmt.Sprintf("[voice-agent] Sent init prompt to %s (notes: %s); awaiting init hook", sessionName, s.notesPath))
	return nil
}

// NotesPath returns the notes file path for this session.
func (s *AgentSession) NotesPath() string { return s.notesPath }

// WaitForInit blocks until the agent fires the init hook, or times out.
func (s *AgentSession) WaitForInit(timeout time.Duration) error {
	select {
	case <-s.initCh:
		return nil
	case <-time.After(timeout):
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

// SendChunk writes the payload to a temp file and pastes it into the tmux session
// using tmux.PastePromptFile — the same mechanism used for multi-line task prompts.
func (s *AgentSession) SendChunk(currentMarkdown, newTranscript string) error {
	s.mu.Lock()
	sessionName := s.tmuxName
	s.mu.Unlock()
	if sessionName == "" {
		return fmt.Errorf("agent session not started")
	}

	payload := ChunkPayload{
		CurrentMarkdown: currentMarkdown,
		NewTranscript:   newTranscript,
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}

	// Write to a temp file so PastePromptFile can load it into a tmux buffer —
	// avoids all shell-quoting issues with embedded quotes/newlines in the JSON.
	f, err := os.CreateTemp("", "tsq-voice-chunk-*.json")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(data); err != nil {
		f.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	f.Close()

	bufName := fmt.Sprintf("voice-%s", sessionName)
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
	logger.Info(fmt.Sprintf("[voice-agent] Session %s killed", s.tmuxName))
	s.tmuxName = ""
}

// installBuiltins writes the tsq-voice-to-md command and sub-agent files to
// all harness command and agent directories (workDir-relative and global).
// Errors are logged but not fatal — missing builtins degrade gracefully.
func (s *AgentSession) installBuiltins() error {
	port := fmt.Sprintf("%d", s.hooksPort)
	workDir := s.agentCfg.WorkDir
	if workDir == "" {
		workDir = s.sessionDir
	}

	cmdContent := strings.NewReplacer("PORT", port, "NOTES_PATH", notesPathExpr).Replace(commandFileContent)
	agentContent := strings.NewReplacer("PORT", port, "NOTES_PATH", notesPathExpr).Replace(subAgentContent)

	var errs []string

	// workDir-relative dirs (picked up by the CLI running in workDir)
	for _, cd := range harness.CommandDirs(workDir) {
		if err := writeBuiltin(cd, "tsq-voice-to-md.md", cmdContent); err != nil {
			errs = append(errs, err.Error())
		}
	}
	for _, ad := range harness.AgentDirs(workDir) {
		if err := writeBuiltin(ad, "tsq-voice-to-md.md", agentContent); err != nil {
			errs = append(errs, err.Error())
		}
	}

	// Global user-level dirs (used when CLI is invoked outside a project dir)
	home, _ := os.UserHomeDir()
	for _, base := range harness.All {
		if err := writeBuiltin(filepath.Join(home, base, "commands"), "tsq-voice-to-md.md", cmdContent); err != nil {
			errs = append(errs, err.Error())
		}
		if err := writeBuiltin(filepath.Join(home, base, "agents"), "tsq-voice-to-md.md", agentContent); err != nil {
			errs = append(errs, err.Error())
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("partial install: %s", strings.Join(errs, "; "))
	}
	return nil
}

// notesPathExpr is used in static command/agent files where the path is resolved
// at runtime by the shell.
const notesPathExpr = `$(date -u +"$HOME/.tsq/notes/%Y%m%d/%H%M%S.md")`

// writeBuiltin creates dir and writes content to dir/name.
func writeBuiltin(dir, name, content string) error {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	return os.WriteFile(filepath.Join(dir, name), []byte(content), 0644)
}

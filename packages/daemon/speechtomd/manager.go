package speechtomd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/whisperer"
)

const (
	silenceFlushDelay = 5 * time.Second
	blankAudioMarker  = "[BLANK_AUDIO]"
)

// Manager orchestrates a speech-to-markdown session: audio → transcription →
// agent processing → markdown update → UI broadcast.
type Manager struct {
	mu           sync.Mutex
	session      *Session
	buffer       *Buffer
	agentSess    *AgentSession
	bc           *Broadcaster
	cfg          *config.Config
	silenceTimer *time.Timer
	editMode     bool
}

// New creates a Manager wired to the given daemon config.
func New(cfg *config.Config) *Manager {
	return &Manager{
		cfg: cfg,
		bc:  NewBroadcaster(),
	}
}

// HandleInit is called by the hook server when the agent fires the init hook.
func (m *Manager) HandleInit() {
	m.mu.Lock()
	as := m.agentSess
	m.mu.Unlock()
	if as != nil {
		as.MarkInitialized()
	}
	m.setSessionState(StateReady)
	logger.Info("[speechtomd] Agent initialised — recording enabled")
}

// HandleResponse is called by the hook server with processed markdown from the agent.
func (m *Manager) HandleResponse(markdown string) {
	markdown = strings.TrimSpace(markdown)
	if markdown == "" {
		return
	}

	m.mu.Lock()
	sess := m.session
	buf := m.buffer
	m.mu.Unlock()

	if sess == nil {
		return
	}

	if err := sess.WriteMarkdown(markdown); err != nil {
		logger.Warn(fmt.Sprintf("[speechtomd] WriteMarkdown: %v", err))
	}
	m.bc.Send(Event{Type: EventMarkdown, Payload: markdown})

	// Promote pending chunks and flush if ready.
	if buf != nil && buf.AgentDone() {
		m.flushToAgent()
	}

	// Agent finished processing, ready for next chunk.
	m.bc.SendAgentStatus(AgentStatusInfo{Status: "idle", Label: "idle"})
}

// HandleNotification is a fallback: calls HandleResponse only if the agent
// hasn't already posted a result via the /response endpoint.
func (m *Manager) HandleNotification(message string) {
	m.mu.Lock()
	sess := m.session
	buf := m.buffer
	m.mu.Unlock()

	if sess == nil || message == "" {
		return
	}

	if buf != nil && buf.IsAgentBusy() {
		m.HandleResponse(message)
	}
}

// SetEditMode updates the edit mode flag for subsequent chunk flushes.
// If recording is active, it flushes the buffer to ensure any pending chunks
// use the previous edit mode before switching.
func (m *Manager) SetEditMode(enabled bool) {
	m.mu.Lock()
	wasRecording := m.session != nil && m.session.State == StateRecording
	oldEditMode := m.editMode
	m.editMode = enabled
	m.mu.Unlock()

	// Flush buffer on edit mode change during active recording to preserve mode per chunk
	if wasRecording && oldEditMode != enabled {
		logger.Info(fmt.Sprintf("[speechtomd] Edit mode changed mid-recording (%v -> %v) — flushing buffer", oldEditMode, enabled))
		m.flushToAgent()
	}
}

// StartSession creates a new session, installs command file, and starts the agent.
func (m *Manager) StartSession(agentName, modelSize string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.session != nil && m.session.State != StateStopped && m.session.State != StateIdle {
		return fmt.Errorf("session already active (state=%s)", m.session.State)
	}

	// Resolve agent config.
	var agentCfg config.AgentConfig
	found := false
	for _, a := range m.cfg.Agents {
		if a.Name == agentName {
			agentCfg = a
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("agent %q not found in config", agentName)
	}

	sess, err := NewSession(agentName, modelSize)
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	m.session = sess
	m.buffer = &Buffer{}

	as := newAgentSession(agentCfg, m.cfg.Hooks.Port, sess.DirPath)
	m.agentSess = as

	m.session.State = StateInitializing
	m.bc.Send(Event{Type: EventState, Payload: StateInitializing.String()})
	m.bc.SendAgentStatus(AgentStatusInfo{Status: "not_started", Label: "not started"})

	go func() {
		if err := as.Start(); err != nil {
			logger.Error(fmt.Sprintf("[speechtomd] Agent start failed: %v", err))
			m.setSessionState(StateStopped)
			m.bc.Send(Event{Type: EventError, Payload: "agent start failed: " + err.Error()})
			m.bc.SendAgentStatus(AgentStatusInfo{Status: "error", Label: "error", Message: err.Error()})
			return
		}
		m.bc.SendAgentStatus(AgentStatusInfo{Status: "processing", Label: "waiting"})
		// Wait up to 90 s for init hook; on timeout, report error with tmux session ID.
		if err := as.WaitForInit(90 * time.Second); err != nil {
			tmuxName := as.TmuxName()
			errMsg := fmt.Sprintf("Agent init timeout after 90s. Run: tmux kill-session -t %s", tmuxName)
			logger.Error(fmt.Sprintf("[speechtomd] %s", errMsg))
			m.setSessionState(StateStopped)
			m.bc.Send(Event{Type: EventError, Payload: errMsg})
			m.bc.SendAgentStatus(AgentStatusInfo{Status: "error", Label: "timeout", Message: tmuxName})
		} else {
			m.setSessionState(StateReady)
			m.bc.SendAgentStatus(AgentStatusInfo{Status: "idle", Label: "idle"})
		}
	}()

	return nil
}

// StartRecording transitions to recording state and applies the edit mode setting.
func (m *Manager) StartRecording(editMode bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.session == nil {
		return fmt.Errorf("no active session; call StartSession first")
	}
	if m.session.State != StateReady && m.session.State != StatePaused {
		return fmt.Errorf("cannot start recording in state %s", m.session.State)
	}
	m.editMode = editMode
	m.session.State = StateRecording
	m.bc.Send(Event{Type: EventState, Payload: StateRecording.String()})
	return nil
}

// PauseRecording pauses without killing the agent and flushes any buffered input.
func (m *Manager) PauseRecording() error {
	m.mu.Lock()
	if m.session == nil || m.session.State != StateRecording {
		m.mu.Unlock()
		return fmt.Errorf("not recording")
	}
	m.session.State = StatePaused
	if m.silenceTimer != nil {
		m.silenceTimer.Stop()
		m.silenceTimer = nil
	}
	m.mu.Unlock()

	m.bc.Send(Event{Type: EventState, Payload: StatePaused.String()})
	m.flushToAgent()
	return nil
}

// StopSession flushes any remaining transcript, kills the agent, and ends the session.
func (m *Manager) StopSession() {
	m.mu.Lock()
	as := m.agentSess
	sess := m.session
	buf := m.buffer
	if m.silenceTimer != nil {
		m.silenceTimer.Stop()
		m.silenceTimer = nil
	}
	m.mu.Unlock()

	if buf != nil && sess != nil {
		if text, em := buf.ForceFlush(); text != "" && as != nil {
			if err := as.SendChunk(sess.ReadMarkdown(), text, em); err != nil {
				logger.Warn(fmt.Sprintf("[speechtomd] Final flush: %v", err))
			}
		}
	}

	if as != nil {
		as.Stop()
	}

	m.mu.Lock()
	m.session = nil
	m.buffer = nil
	m.agentSess = nil
	m.mu.Unlock()

	m.bc.Send(Event{Type: EventState, Payload: StateStopped.String()})
	m.bc.SendAgentStatus(AgentStatusInfo{Status: "stopped", Label: "stopped"})
}

// ReceiveAudioChunk transcribes an audio chunk and feeds the text into the pipeline.
func (m *Manager) ReceiveAudioChunk(modelSize string, audioData []byte) error {
	m.mu.Lock()
	sess := m.session
	editMode := m.editMode
	m.mu.Unlock()

	if sess == nil {
		logger.Warn("[speechtomd] upload received but no session active")
		return fmt.Errorf("no active session")
	}
	if sess.State != StateRecording {
		logger.Warn(fmt.Sprintf("[speechtomd] upload received but not recording (state: %s)", sess.State))
		return fmt.Errorf("not recording (state: %s)", sess.State)
	}

	modelPath, err := whisperer.ModelPath(whisperer.ModelSize(modelSize))
	if err != nil {
		return fmt.Errorf("model not found: %w", err)
	}

	text, err := whisperer.TranscribeBytes(audioData, modelPath)
	if err != nil {
		logger.Warn(fmt.Sprintf("[speechtomd] transcribe: %v", err))
		return err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}

	// Whisper signals silence as [BLANK_AUDIO] — flush buffered input to the agent.
	if strings.Contains(text, blankAudioMarker) {
		logger.Info("[speechtomd] blank audio detected — flushing buffer")
		m.flushToAgent()
		return nil
	}

	// Real speech: reset the 5-second silence timer.
	m.resetSilenceTimer()

	if err := sess.AppendTranscript(text); err != nil {
		logger.Warn(fmt.Sprintf("[speechtomd] AppendTranscript: %v", err))
	}
	transcriptJSON, _ := json.Marshal(map[string]any{"text": text, "edit_mode": editMode})
	m.bc.Send(Event{Type: EventTranscript, Payload: string(transcriptJSON)})

	if m.buffer.Add(text, editMode) {
		m.flushToAgent()
	}
	return nil
}

// HandleUploadRequest processes an audio upload HTTP request.
func (m *Manager) HandleUploadRequest(r *http.Request) error {
	modelSize := r.URL.Query().Get("model")
	if modelSize == "" {
		modelSize = "base"
	}
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}
	return m.ReceiveAudioChunk(modelSize, data)
}

// Status returns a JSON-serialisable snapshot of the current session.
func (m *Manager) Status() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.session == nil {
		return map[string]any{"state": "idle"}
	}
	notesPath := ""
	if m.agentSess != nil {
		notesPath = m.agentSess.NotesPath()
	}
	return map[string]any{
		"state":      m.session.State.String(),
		"session_id": m.session.ID,
		"agent":      m.session.AgentName,
		"model":      m.session.ModelSize,
		"txt_path":   m.session.TxtPath,
		"md_path":    m.session.MdPath,
		"notes_path": notesPath,
		"edit_mode":  m.editMode,
	}
}

// Markdown returns the current processed markdown content.
func (m *Manager) Markdown() string {
	m.mu.Lock()
	sess := m.session
	m.mu.Unlock()
	if sess == nil {
		return ""
	}
	return sess.ReadMarkdown()
}

// Transcript returns the full raw transcript.
func (m *Manager) Transcript() string {
	m.mu.Lock()
	sess := m.session
	m.mu.Unlock()
	if sess == nil {
		return ""
	}
	return sess.ReadTranscript()
}

// ServeSSE exposes the broadcaster's SSE handler for the dashboard router.
func (m *Manager) ServeSSE(w http.ResponseWriter, r *http.Request) {
	m.bc.ServeSSE(w, r)
}

// flushToAgent sends accumulated transcript to the agent.
func (m *Manager) flushToAgent() {
	m.mu.Lock()
	sess := m.session
	as := m.agentSess
	buf := m.buffer
	m.mu.Unlock()

	if sess == nil || as == nil || buf == nil {
		return
	}

	text, flushEditMode := buf.Flush()
	if text == "" {
		return
	}

	m.bc.SendAgentStatus(AgentStatusInfo{Status: "processing", Label: "processing"})

	currentMD := sess.ReadMarkdown()
	go func() {
		if err := as.SendChunk(currentMD, text, flushEditMode); err != nil {
			logger.Warn(fmt.Sprintf("[speechtomd] SendChunk: %v", err))
			m.bc.SendAgentStatus(AgentStatusInfo{Status: "error", Label: "error", Message: err.Error()})
			buf.AgentDone()
		}
	}()
}

// resetSilenceTimer restarts the 5-second silence flush timer.
func (m *Manager) resetSilenceTimer() {
	m.mu.Lock()
	if m.silenceTimer != nil {
		m.silenceTimer.Stop()
	}
	m.silenceTimer = time.AfterFunc(silenceFlushDelay, m.flushToAgent)
	m.mu.Unlock()
}

// setSessionState sets state under lock and broadcasts it.
func (m *Manager) setSessionState(state State) {
	m.mu.Lock()
	if m.session != nil {
		m.session.State = state
	}
	m.mu.Unlock()
	m.bc.Send(Event{Type: EventState, Payload: state.String()})
}

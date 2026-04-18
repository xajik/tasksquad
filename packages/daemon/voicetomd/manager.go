package voicetomd

import (
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

// Manager orchestrates a voice-to-markdown session: audio → transcription →
// agent processing → markdown update → UI broadcast.
type Manager struct {
	mu        sync.Mutex
	session   *Session
	buffer    *Buffer
	agentSess *AgentSession
	bc        *Broadcaster
	cfg       *config.Config
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
	logger.Info("[voicetomd] Agent initialised — recording enabled")
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
		logger.Warn(fmt.Sprintf("[voicetomd] WriteMarkdown: %v", err))
	}
	m.bc.Send(Event{Type: EventMarkdown, Payload: markdown})

	// Promote pending chunks and flush if ready.
	if buf != nil && buf.AgentDone() {
		m.flushToAgent()
	}
}

// HandleNotification is called by the hook server when Claude's Notification hook fires
// (Claude finished its turn and is waiting for the next user message).
// We use this to read the last assistant response from the transcript and treat it
// as the processed markdown response when the agent hasn't posted an explicit hook yet.
func (m *Manager) HandleNotification(transcriptPath string) {
	m.mu.Lock()
	sess := m.session
	buf := m.buffer
	m.mu.Unlock()

	if sess == nil {
		return
	}

	// If agent is still busy (hasn't posted via /response endpoint), try transcript.
	if buf != nil && buf.agentBusy {
		text := whisperer.ExtractLastAssistantText(transcriptPath)
		if text != "" {
			m.HandleResponse(text)
		}
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

	go func() {
		if err := as.Start(); err != nil {
			logger.Error(fmt.Sprintf("[voicetomd] Agent start failed: %v", err))
			m.setSessionState(StateStopped)
			m.bc.Send(Event{Type: EventError, Payload: "agent start failed: " + err.Error()})
			return
		}
		// Wait up to 90 s for init hook; fall back to ready state.
		if err := as.WaitForInit(90 * time.Second); err != nil {
			logger.Warn("[voicetomd] Agent init timeout; enabling recording as fallback")
			m.setSessionState(StateReady)
		}
	}()

	return nil
}

// StartRecording transitions to recording state.
func (m *Manager) StartRecording() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.session == nil {
		return fmt.Errorf("no active session; call StartSession first")
	}
	if m.session.State != StateReady && m.session.State != StatePaused {
		return fmt.Errorf("cannot start recording in state %s", m.session.State)
	}
	m.session.State = StateRecording
	m.bc.Send(Event{Type: EventState, Payload: StateRecording.String()})
	return nil
}

// PauseRecording pauses without killing the agent.
func (m *Manager) PauseRecording() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.session == nil || m.session.State != StateRecording {
		return fmt.Errorf("not recording")
	}
	m.session.State = StatePaused
	m.bc.Send(Event{Type: EventState, Payload: StatePaused.String()})
	return nil
}

// StopSession flushes any remaining transcript, kills the agent, and ends the session.
func (m *Manager) StopSession() {
	m.mu.Lock()
	as := m.agentSess
	sess := m.session
	buf := m.buffer
	m.mu.Unlock()

	if buf != nil && sess != nil {
		if text := buf.ForceFlush(); text != "" && as != nil {
			if err := as.SendChunk(sess.ReadMarkdown(), text); err != nil {
				logger.Warn(fmt.Sprintf("[voicetomd] Final flush: %v", err))
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
}

// ReceiveAudioChunk transcribes an audio chunk and feeds the text into the pipeline.
func (m *Manager) ReceiveAudioChunk(modelSize string, audioData []byte) error {
	m.mu.Lock()
	sess := m.session
	m.mu.Unlock()

	if sess == nil || sess.State != StateRecording {
		return fmt.Errorf("not recording")
	}

	modelPath, err := whisperer.ModelPath(whisperer.ModelSize(modelSize))
	if err != nil {
		return fmt.Errorf("model not found: %w", err)
	}

	text, err := whisperer.TranscribeBytes(audioData, modelPath)
	if err != nil {
		logger.Warn(fmt.Sprintf("[voicetomd] transcribe: %v", err))
		return err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}

	if err := sess.AppendTranscript(text); err != nil {
		logger.Warn(fmt.Sprintf("[voicetomd] AppendTranscript: %v", err))
	}
	m.bc.Send(Event{Type: EventTranscript, Payload: text})

	if m.buffer.Add(text) {
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
	return map[string]any{
		"state":      m.session.State.String(),
		"session_id": m.session.ID,
		"agent":      m.session.AgentName,
		"model":      m.session.ModelSize,
		"txt_path":   m.session.TxtPath,
		"md_path":    m.session.MdPath,
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

	text := buf.Flush()
	if text == "" {
		return
	}

	currentMD := sess.ReadMarkdown()
	go func() {
		if err := as.SendChunk(currentMD, text); err != nil {
			logger.Warn(fmt.Sprintf("[voicetomd] SendChunk: %v", err))
			buf.AgentDone()
		}
	}()
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

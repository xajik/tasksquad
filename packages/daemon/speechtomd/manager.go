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
	maxBatchDuration = 15 * time.Second
	blankAudioMarker = "[BLANK_AUDIO]"
)

// Manager orchestrates a speech-to-markdown session: audio → transcription →
// agent processing → markdown update → UI broadcast.
type Manager struct {
	mu         sync.Mutex
	session    *Session
	queue      *ChunkQueue
	agentSess  *AgentSession
	bc         *Broadcaster
	cfg        *config.Config
	batchTimer *time.Timer
	editMode   bool
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

// HandleNotification handles a provider turn-complete signal.
// The first stop event while initializing is treated as the ready signal.
// Subsequent events carry the markdown result for the current chunk batch.
func (m *Manager) HandleNotification(message string) {
	m.mu.Lock()
	sess := m.session
	as := m.agentSess
	queue := m.queue
	initializing := sess != nil && sess.State == StateInitializing
	m.mu.Unlock()

	if sess == nil {
		return
	}

	if initializing {
		logger.Info("[speechtomd] HandleNotification: session initializing — marking ready")
		m.HandleInit()
		return
	}

	if queue == nil {
		return
	}

	// Write markdown while processing=true — no concurrent flush possible.
	markdown := strings.TrimSpace(message)
	if markdown != "" {
		if err := sess.WriteMarkdown(markdown); err != nil {
			logger.Warn(fmt.Sprintf("[speechtomd] WriteMarkdown: %v", err))
		}
		m.bc.Send(Event{Type: EventMarkdown, Payload: markdown})
	}

	// Atomically claim the next batch. If chunks accumulated during processing,
	// MarkDone keeps processing=true and returns them; otherwise goes idle.
	if nextText, hasNext := queue.MarkDone(); hasNext {
		m.bc.SendAgentStatus(AgentStatusInfo{Status: "processing", Label: "processing"})
		go func() {
			if err := as.SendChunk(nextText); err != nil {
				logger.Warn(fmt.Sprintf("[speechtomd] SendChunk (next batch): %v", err))
				m.bc.SendAgentStatus(AgentStatusInfo{Status: "error", Label: "error", Message: err.Error()})
				queue.AgentDone()
				m.bc.SendAgentStatus(AgentStatusInfo{Status: "idle", Label: "idle"})
			}
		}()
	} else {
		m.bc.SendAgentStatus(AgentStatusInfo{Status: "idle", Label: "idle"})
	}
}

// SetEditMode updates the edit mode flag. Flushes if recording is active and mode changed.
func (m *Manager) SetEditMode(enabled bool) {
	m.mu.Lock()
	wasRecording := m.session != nil && m.session.State == StateRecording
	oldEditMode := m.editMode
	m.editMode = enabled
	m.mu.Unlock()

	if wasRecording && oldEditMode != enabled {
		logger.Info(fmt.Sprintf("[speechtomd] Edit mode changed mid-recording (%v -> %v) — flushing", oldEditMode, enabled))
		m.flushToAgent()
	}
}

// StartSession creates a new session and starts the agent.
func (m *Manager) StartSession(agentName, modelSize, prompt string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.session != nil && m.session.State != StateStopped && m.session.State != StateIdle {
		return fmt.Errorf("session already active (state=%s)", m.session.State)
	}

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
	m.queue = NewChunkQueue()

	as := newAgentSession(agentCfg, m.cfg.Hooks.Port, sess.DirPath, prompt)
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

// StartRecording transitions to recording state.
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

// PauseRecording pauses and flushes any buffered input.
func (m *Manager) PauseRecording() error {
	m.mu.Lock()
	if m.session == nil || m.session.State != StateRecording {
		m.mu.Unlock()
		return fmt.Errorf("not recording")
	}
	m.session.State = StatePaused
	m.mu.Unlock()

	m.stopBatchTimer()
	m.bc.Send(Event{Type: EventState, Payload: StatePaused.String()})
	m.flushToAgent()
	return nil
}

// StopSession kills the agent and ends the session without flushing remaining chunks.
func (m *Manager) StopSession() {
	m.stopBatchTimer()

	m.mu.Lock()
	as := m.agentSess
	m.mu.Unlock()

	if as != nil {
		as.Stop()
	}

	m.mu.Lock()
	m.session = nil
	m.queue = nil
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

	// Silence detected — flush immediately without enqueuing the marker.
	if strings.Contains(text, blankAudioMarker) {
		logger.Info("[speechtomd] blank audio detected — flushing")
		m.flushToAgent()
		return nil
	}

	if err := sess.AppendTranscript(text); err != nil {
		logger.Warn(fmt.Sprintf("[speechtomd] AppendTranscript: %v", err))
	}
	transcriptJSON, _ := json.Marshal(map[string]any{"text": text, "edit_mode": editMode})
	m.bc.Send(Event{Type: EventTranscript, Payload: string(transcriptJSON)})

	// Enqueue the chunk. If this is the first chunk of a new idle batch, start
	// the 15 s timer so the batch is flushed even if the user talks non-stop.
	if isFirst := m.queue.Enqueue(text, editMode); isFirst {
		m.startBatchTimer()
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

// flushToAgent sends all queued chunks to the agent.
func (m *Manager) flushToAgent() {
	m.stopBatchTimer()

	m.mu.Lock()
	sess := m.session
	as := m.agentSess
	queue := m.queue
	m.mu.Unlock()

	if sess == nil || as == nil || queue == nil {
		return
	}

	text := queue.Flush()
	if text == "" {
		return
	}

	m.bc.SendAgentStatus(AgentStatusInfo{Status: "processing", Label: "processing"})

	go func() {
		if err := as.SendChunk(text); err != nil {
			logger.Warn(fmt.Sprintf("[speechtomd] SendChunk: %v", err))
			m.bc.SendAgentStatus(AgentStatusInfo{Status: "error", Label: "error", Message: err.Error()})
			queue.AgentDone()
			m.bc.SendAgentStatus(AgentStatusInfo{Status: "idle", Label: "idle"})
		}
	}()
}

// startBatchTimer starts the 15 s one-shot timer that flushes the current batch
// if the user keeps talking without a natural pause.
func (m *Manager) startBatchTimer() {
	m.mu.Lock()
	if m.batchTimer != nil {
		m.batchTimer.Stop()
	}
	m.batchTimer = time.AfterFunc(maxBatchDuration, m.flushToAgent)
	m.mu.Unlock()
}

// stopBatchTimer cancels the batch timer if running.
func (m *Manager) stopBatchTimer() {
	m.mu.Lock()
	if m.batchTimer != nil {
		m.batchTimer.Stop()
		m.batchTimer = nil
	}
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

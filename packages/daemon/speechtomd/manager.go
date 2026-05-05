package speechtomd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/whisperer"
)

// errAgentTimeout is returned by ChunkAgent.Complete when the backend does not
// respond within its deadline. The queue is reset silently so transcription
// continues into the next cycle; no error state is surfaced to the user.
var errAgentTimeout = errors.New("agent timeout")

// whisperEventRe strips non-speech event annotations that Whisper emits in
// several bracket styles: *music*, [BIRDS CHIRPING], (birds chirping).
var whisperEventRe = regexp.MustCompile(`\*[^*\n]+\*|\[[^\]\n]+\]|\([^)\n]+\)`)

const (
	maxBatchDuration = 15 * time.Second
	minFlushWords    = 30
	blankAudioMarker = "[BLANK_AUDIO]"
)

// ChunkAgent is the common interface for all speech-to-markdown backends.
// Implementations: tmuxAgent (hook-based) and localModelAgent (HTTP API).
type ChunkAgent interface {
	// Start initialises the agent and blocks until it is ready to process chunks.
	Start() error
	// Complete processes one transcript batch and returns the updated markdown.
	Complete(currentMD, transcript string, editMode bool) (string, error)
	// Stop tears down the agent.
	Stop()
}

// HookNotifiable is an optional extension of ChunkAgent for backends that
// receive results through the daemon's HTTP hook callbacks (e.g. tmuxAgent).
type HookNotifiable interface {
	MarkInitialized()
	DeliverResult(markdown string)
}

// Manager orchestrates a speech-to-markdown session: audio → transcription →
// agent processing → markdown update → UI broadcast.
type Manager struct {
	mu              sync.Mutex
	session         *Session
	queue           *ChunkQueue
	agent           ChunkAgent
	bc              *Broadcaster
	cfg             *config.Config
	batchTimer      *time.Timer
	editMode        bool
	statusMu        sync.Mutex       // protects lastAgentStatus only; separate from mu
	lastAgentStatus *AgentStatusInfo // replayed to new SSE subscribers
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
	agent := m.agent
	m.mu.Unlock()
	if hn, ok := agent.(HookNotifiable); ok {
		hn.MarkInitialized()
	}
	m.setSessionState(StateReady)
	logger.Info("[speechtomd] Agent initialised — recording enabled")
}

// HandleNotification handles a provider turn-complete signal.
// The first stop event while initializing is treated as the ready signal.
// Subsequent events are routed to the agent's DeliverResult for hook-based backends.
func (m *Manager) HandleNotification(message string) {
	m.mu.Lock()
	sess := m.session
	agent := m.agent
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

	if hn, ok := agent.(HookNotifiable); ok {
		hn.DeliverResult(message)
	}
}

func (m *Manager) handleAgentResult(markdown string) {
	m.mu.Lock()
	sess := m.session
	queue := m.queue
	m.mu.Unlock()

	if sess == nil || queue == nil {
		return
	}

	markdown = strings.TrimSpace(markdown)
	if markdown != "" {
		if err := sess.WriteMarkdown(markdown); err != nil {
			logger.Warn(fmt.Sprintf("[speechtomd] WriteMarkdown: %v", err))
		}
		m.bc.Send(Event{Type: EventMarkdown, Payload: markdown})
	}

	if next, hasNext := queue.MarkDone(); hasNext {
		m.sendAgentStatus(AgentStatusInfo{Status: "processing", Label: "processing"})
		m.dispatchChunk(next)
	} else {
		m.sendAgentStatus(AgentStatusInfo{Status: "idle", Label: "idle"})
	}
}

func (m *Manager) dispatchChunk(batch Batch) {
	m.mu.Lock()
	agent := m.agent
	sess := m.session
	queue := m.queue
	m.mu.Unlock()

	if agent == nil {
		return
	}

	currentMD := ""
	if sess != nil {
		currentMD = sess.ReadMarkdown()
	}

	errPath := func(err error) {
		logger.Warn(fmt.Sprintf("[speechtomd] dispatch: %v", err))
		m.sendAgentStatus(AgentStatusInfo{Status: "error", Label: "error", Message: err.Error()})
		if queue != nil {
			queue.AgentDone()
		}
		m.sendAgentStatus(AgentStatusInfo{Status: "idle", Label: "idle"})
	}

	go func() {
		m.sendAgentStatus(AgentStatusInfo{Status: "processing", Label: "processing"})
		result, err := agent.Complete(currentMD, batch.Text, batch.EditMode)
		if errors.Is(err, errAgentTimeout) {
			logger.Warn("[speechtomd] agent timed out — batch dropped, continuing next cycle")
			if queue != nil {
				queue.AgentDone()
			}
			m.sendAgentStatus(AgentStatusInfo{Status: "idle", Label: "idle"})
			return
		}
		if err != nil {
			errPath(fmt.Errorf("agent: %w", err))
			return
		}
		m.handleAgentResult(result)
	}()
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

// sessionIsActive reports whether a session is running and not yet stopped.
// Must be called with m.mu held.
func (m *Manager) sessionIsActive() bool {
	return m.session != nil && m.session.State != StateStopped && m.session.State != StateIdle
}

// StartSession creates a new session backed by a configured tmux agent.
func (m *Manager) StartSession(agentName, modelSize, prompt string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.sessionIsActive() {
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

	ta := newTmuxAgent(agentCfg, m.cfg.Hooks.Port, sess.DirPath, prompt)
	m.agent = ta

	m.session.State = StateInitializing
	m.bc.Send(Event{Type: EventState, Payload: StateInitializing.String()})
	m.sendAgentStatus(AgentStatusInfo{Status: "not_started", Label: "not started"})

	m.startAgentAsync(ta)
	return nil
}

// StartLocalSession starts a session backed by a local omlx model instead of a
// configured tmux agent. No config.toml entry is required.
// omlxModel is the model name returned by /v1/models; empty string auto-selects the first model.
// whisperModel is the Whisper model size used for transcription (e.g. "base").
func (m *Manager) StartLocalSession(omlxModel, whisperModel, prompt string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.sessionIsActive() {
		return fmt.Errorf("session already active (state=%s)", m.session.State)
	}

	sess, err := NewSession("local", whisperModel)
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	m.session = sess
	m.queue = NewChunkQueue()

	la := newLocalModelAgent("", omlxModel)
	m.agent = la

	m.session.State = StateInitializing
	m.bc.Send(Event{Type: EventState, Payload: StateInitializing.String()})
	m.sendAgentStatus(AgentStatusInfo{Status: "not_started", Label: "not started"})

	m.startAgentAsync(la)
	return nil
}

// startAgentAsync calls agent.Start() in a goroutine, broadcasting state transitions.
func (m *Manager) startAgentAsync(agent ChunkAgent) {
	go func() {
		if err := agent.Start(); err != nil {
			logger.Error(fmt.Sprintf("[speechtomd] Agent start failed: %v", err))
			m.setSessionState(StateStopped)
			m.bc.Send(Event{Type: EventError, Payload: "agent start failed: " + err.Error()})
			m.sendAgentStatus(AgentStatusInfo{Status: "error", Label: "error", Message: err.Error()})
			return
		}
		m.setSessionState(StateReady)
		m.sendAgentStatus(AgentStatusInfo{Status: "idle", Label: "idle"})
	}()
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
	agent := m.agent
	m.mu.Unlock()

	if agent != nil {
		agent.Stop()
	}

	m.mu.Lock()
	m.session = nil
	m.queue = nil
	m.agent = nil
	m.mu.Unlock()

	m.bc.Send(Event{Type: EventState, Payload: StateStopped.String()})
	m.sendAgentStatus(AgentStatusInfo{Status: "stopped", Label: "stopped"})
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

	if strings.Contains(text, blankAudioMarker) {
		logger.Info("[speechtomd] blank audio detected — flushing")
		m.flushToAgent()
		return nil
	}

	text = strings.TrimSpace(whisperEventRe.ReplaceAllString(text, ""))
	if text == "" {
		return nil
	}

	if err := sess.AppendTranscript(text); err != nil {
		logger.Warn(fmt.Sprintf("[speechtomd] AppendTranscript: %v", err))
	}
	transcriptJSON, _ := json.Marshal(struct {
		Text     string `json:"text"`
		EditMode bool   `json:"edit_mode"`
	}{text, editMode})
	m.bc.Send(Event{Type: EventTranscript, Payload: string(transcriptJSON)})

	isFirst, words := m.queue.Enqueue(text, editMode)
	if isFirst {
		m.startBatchTimer()
	}
	if words >= minFlushWords {
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

// ServeSSE serves the SSE stream, replaying current state + agent status to
// each new subscriber so clients that connect after a fast transition (e.g.
// local model reaching ready in <100 ms) don't stay stuck on "initializing".
func (m *Manager) ServeSSE(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	// Subscribe before reading current state to avoid missing concurrent events.
	ch := m.bc.add()
	defer m.bc.remove(ch)

	fmt.Fprintf(w, ": connected\n\n") //nolint:errcheck
	flusher.Flush()

	// Replay snapshot so clients never miss a state that fired before they connected.
	m.mu.Lock()
	var statePayload string
	if m.session != nil {
		statePayload = m.session.State.String()
	}
	m.mu.Unlock()

	m.statusMu.Lock()
	lastStatus := m.lastAgentStatus
	m.statusMu.Unlock()

	send := func(ev Event) {
		data, _ := json.Marshal(ev)
		fmt.Fprintf(w, "data: %s\n\n", data) //nolint:errcheck
		flusher.Flush()
	}

	if statePayload != "" {
		send(Event{Type: EventState, Payload: statePayload})
	}
	if lastStatus != nil {
		data, _ := json.Marshal(AgentStatusEvent{Type: EventAgentStatus, Payload: *lastStatus})
		send(Event{Type: EventAgentStatus, Payload: string(data)})
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			send(ev)
		}
	}
}

// sendAgentStatus stores the status for SSE replay then broadcasts it.
// Uses statusMu (not mu) so it is safe to call while mu is held.
func (m *Manager) sendAgentStatus(info AgentStatusInfo) {
	m.statusMu.Lock()
	m.lastAgentStatus = &info
	m.statusMu.Unlock()
	m.bc.SendAgentStatus(info)
}

func (m *Manager) flushToAgent() {
	m.stopBatchTimer()

	m.mu.Lock()
	sess := m.session
	queue := m.queue
	m.mu.Unlock()

	if sess == nil || queue == nil {
		return
	}

	batch := queue.Flush()
	if batch.Text == "" {
		return
	}

	m.sendAgentStatus(AgentStatusInfo{Status: "processing", Label: "processing"})
	m.dispatchChunk(batch)
}

func (m *Manager) startBatchTimer() {
	m.mu.Lock()
	if m.batchTimer != nil {
		m.batchTimer.Stop()
	}
	m.batchTimer = time.AfterFunc(maxBatchDuration, m.flushToAgent)
	m.mu.Unlock()
}

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


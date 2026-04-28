package speechtomd

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
)

// EventType identifies the kind of SSE event sent to the UI.
type EventType string

const (
	EventTranscript   EventType = "transcript"   // new raw transcript segment
	EventMarkdown     EventType = "markdown"     // updated processed document
	EventState        EventType = "state"        // session state change
	EventError        EventType = "error"        // error message
	EventProgress     EventType = "progress"     // model download progress (0–100)
	EventAgentStatus  EventType = "agent_status" // agent processing status
)

// AgentStatusEvent carries agent processing state for the UI badge.
type AgentStatusEvent struct {
	Type    EventType       `json:"type"`
	Payload AgentStatusInfo `json:"payload"`
}

// AgentStatusInfo describes the agent's current processing state.
type AgentStatusInfo struct {
	Status  string `json:"status"`  // not_started, idle, processing, error, stopped
	Label   string `json:"label"`   // human-readable label
	Message string `json:"message"` // optional detail (e.g. error text)
}

// Event is the payload sent to all connected SSE clients.
type Event struct {
	Type    EventType `json:"type"`
	Payload string    `json:"payload"`
}

// Broadcaster fans out events to all connected SSE clients.
type Broadcaster struct {
	mu      sync.Mutex
	clients map[chan Event]struct{}
}

// NewBroadcaster creates an initialised broadcaster.
func NewBroadcaster() *Broadcaster {
	return &Broadcaster{clients: make(map[chan Event]struct{})}
}

// Send delivers an event to every connected client. Slow clients are skipped.
func (b *Broadcaster) Send(ev Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.clients {
		select {
		case ch <- ev:
		default:
		}
	}
}

// SendAgentStatus broadcasts an agent status update as a structured event.
func (b *Broadcaster) SendAgentStatus(info AgentStatusInfo) {
	data, _ := json.Marshal(AgentStatusEvent{
		Type:    EventAgentStatus,
		Payload: info,
	})
	b.Send(Event{Type: EventAgentStatus, Payload: string(data)})
}

func (b *Broadcaster) add() chan Event {
	ch := make(chan Event, 64)
	b.mu.Lock()
	b.clients[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

func (b *Broadcaster) remove(ch chan Event) {
	b.mu.Lock()
	delete(b.clients, ch)
	b.mu.Unlock()
}

// ServeSSE writes Server-Sent Events to w until the client disconnects.
func (b *Broadcaster) ServeSSE(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	ch := b.add()
	defer b.remove(ch)

	fmt.Fprintf(w, ": connected\n\n")
	flusher.Flush()

	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			data, _ := json.Marshal(ev)
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}
}

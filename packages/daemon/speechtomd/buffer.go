package speechtomd

import (
	"strings"
	"sync"
)

const minWordsToFlush = 30 // flush to agent once this many words accumulate

// chunk is a single transcript segment with its capture-time edit mode.
type chunk struct {
	text     string
	editMode bool
}

// Buffer accumulates transcript chunks and decides when to flush to the agent.
// New chunks are added to "accumulated" while the agent is free; once the agent
// is processing they go into "pending" so they are not lost. When the agent
// finishes, pending chunks are promoted to accumulated and readiness is re-evaluated.
type Buffer struct {
	mu          sync.Mutex
	accumulated []chunk
	pending     []chunk
	agentBusy   bool
}

// Add appends a transcript segment with its edit mode. Returns true if ready to flush.
func (b *Buffer) Add(text string, editMode bool) bool {
	text = strings.TrimSpace(text)
	if text == "" {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	c := chunk{text: text, editMode: editMode}
	if b.agentBusy {
		b.pending = append(b.pending, c)
		return false
	}
	b.accumulated = append(b.accumulated, c)
	return b.shouldFlush()
}

// shouldFlush returns true when enough text is ready. Must hold mu.
func (b *Buffer) shouldFlush() bool {
	words := 0
	for _, c := range b.accumulated {
		words += len(strings.Fields(c.text))
	}
	return words >= minWordsToFlush
}

// Flush returns the accumulated text and the edit mode of the batch.
// Returns ("", false) if nothing has accumulated.
// All chunks in a batch share the same edit mode because SetEditMode flushes on change.
func (b *Buffer) Flush() (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.accumulated) == 0 {
		return "", false
	}
	editMode := b.accumulated[0].editMode
	texts := make([]string, len(b.accumulated))
	for i, c := range b.accumulated {
		texts[i] = c.text
	}
	text := strings.Join(texts, " ")
	b.accumulated = nil
	b.agentBusy = true
	return text, editMode
}

// ForceFlush flushes regardless of the word threshold. Used on session stop.
func (b *Buffer) ForceFlush() (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.accumulated) == 0 && len(b.pending) == 0 {
		return "", false
	}
	all := append(b.accumulated, b.pending...)
	b.accumulated = nil
	b.pending = nil
	b.agentBusy = true
	if len(all) == 0 {
		return "", false
	}
	editMode := all[0].editMode
	texts := make([]string, len(all))
	for i, c := range all {
		texts[i] = c.text
	}
	return strings.Join(texts, " "), editMode
}

// AgentDone marks the agent as free and promotes pending → accumulated.
// Returns true if the new accumulated content is already ready to flush.
func (b *Buffer) AgentDone() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.agentBusy = false
	b.accumulated = append(b.accumulated, b.pending...)
	b.pending = nil
	return b.shouldFlush()
}

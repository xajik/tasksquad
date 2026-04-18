package voicetomd

import (
	"strings"
	"sync"
)

const minWordsToFlush = 30 // flush to agent once this many words accumulate

// Buffer accumulates transcript chunks and decides when to flush to the agent.
// New chunks are added to "accumulated" while the agent is free; once the agent
// is processing they go into "pending" so they are not lost. When the agent
// finishes, pending chunks are promoted to accumulated and readiness is re-evaluated.
type Buffer struct {
	mu          sync.Mutex
	accumulated []string
	pending     []string
	agentBusy   bool
}

// Add appends a transcript segment. Returns true if the buffer is ready to flush.
func (b *Buffer) Add(text string) bool {
	text = strings.TrimSpace(text)
	if text == "" {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.agentBusy {
		b.pending = append(b.pending, text)
		return false
	}
	b.accumulated = append(b.accumulated, text)
	return b.shouldFlush()
}

// shouldFlush returns true when enough text is ready. Must hold mu.
func (b *Buffer) shouldFlush() bool {
	words := 0
	for _, c := range b.accumulated {
		words += len(strings.Fields(c))
	}
	return words >= minWordsToFlush
}

// Flush returns the accumulated text and marks the agent as busy.
// Returns "" if nothing has accumulated.
func (b *Buffer) Flush() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.accumulated) == 0 {
		return ""
	}
	text := strings.Join(b.accumulated, " ")
	b.accumulated = nil
	b.agentBusy = true
	return text
}

// ForceFlush flushes regardless of the word threshold. Used on session stop.
func (b *Buffer) ForceFlush() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.accumulated) == 0 && len(b.pending) == 0 {
		return ""
	}
	all := append(b.accumulated, b.pending...)
	b.accumulated = nil
	b.pending = nil
	b.agentBusy = true
	return strings.Join(all, " ")
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

package speechtomd

import (
	"strings"
	"sync"
)

type chunk struct {
	text     string
	editMode bool
}

// ChunkQueue is a single chronological queue of transcript chunks.
// Enqueue always appends. Flush and MarkDone enforce strict serial processing:
// only one agent call runs at a time.
type ChunkQueue struct {
	mu         sync.Mutex
	queue      []chunk
	processing bool
}

func NewChunkQueue() *ChunkQueue {
	return &ChunkQueue{}
}

// Enqueue appends a chunk. Returns true when this is the first chunk of a new
// idle batch — the caller should start the 15 s batch timer.
func (q *ChunkQueue) Enqueue(text string, editMode bool) bool {
	text = strings.TrimSpace(text)
	if text == "" {
		return false
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	isFirst := len(q.queue) == 0 && !q.processing
	q.queue = append(q.queue, chunk{text: text, editMode: editMode})
	return isFirst
}

// Flush atomically takes all queued chunks and marks processing=true.
// Returns "" if already processing or the queue is empty.
func (q *ChunkQueue) Flush() string {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.processing || len(q.queue) == 0 {
		return ""
	}
	text := joinChunks(q.queue)
	q.queue = nil
	q.processing = true
	return text
}

// MarkDone is called when the agent replies.
// If chunks accumulated during processing, keeps processing=true and returns
// the next batch. Otherwise sets processing=false and returns ("", false).
func (q *ChunkQueue) MarkDone() (string, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.queue) > 0 {
		text := joinChunks(q.queue)
		q.queue = nil
		// processing stays true — next batch is already claimed
		return text, true
	}
	q.processing = false
	return "", false
}

// AgentDone resets the processing flag on the error path (no agent reply expected).
func (q *ChunkQueue) AgentDone() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.processing = false
}

func joinChunks(chunks []chunk) string {
	texts := make([]string, len(chunks))
	for i, c := range chunks {
		texts[i] = c.text
	}
	return strings.Join(texts, " ")
}

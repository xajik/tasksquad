package speechtomd

import (
	"strings"
	"sync"
)

type chunk struct {
	text     string
	editMode bool
}

// Batch is returned by Flush and MarkDone.
type Batch struct {
	Text     string
	EditMode bool
}

// ChunkQueue is a chronological queue of transcript chunks with strict serial
// processing: only one agent call runs at a time.
type ChunkQueue struct {
	mu         sync.Mutex
	queue      []chunk
	wordCount  int
	processing bool
}

func NewChunkQueue() *ChunkQueue {
	return &ChunkQueue{}
}

// Enqueue appends a chunk. Returns (isFirst, totalWords) where isFirst is true
// when this is the first chunk of a new idle batch — the caller should start
// the batch timer. totalWords is the running word count across all buffered chunks.
func (q *ChunkQueue) Enqueue(text string, editMode bool) (bool, int) {
	text = strings.TrimSpace(text)
	if text == "" {
		return false, 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	isFirst := len(q.queue) == 0 && !q.processing
	q.queue = append(q.queue, chunk{text: text, editMode: editMode})
	q.wordCount += len(strings.Fields(text))
	return isFirst, q.wordCount
}

// Flush atomically takes all queued chunks and marks processing=true.
// Returns a zero Batch if already processing or the queue is empty.
func (q *ChunkQueue) Flush() Batch {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.processing || len(q.queue) == 0 {
		return Batch{}
	}
	b := joinChunks(q.queue)
	q.queue = nil
	q.wordCount = 0
	q.processing = true
	return b
}

// MarkDone is called when the agent replies. If chunks accumulated during
// processing, keeps processing=true and returns the next batch. Otherwise
// clears processing and returns (Batch{}, false).
func (q *ChunkQueue) MarkDone() (Batch, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.queue) > 0 {
		b := joinChunks(q.queue)
		q.queue = nil
		q.wordCount = 0
		return b, true
	}
	q.processing = false
	return Batch{}, false
}

// AgentDone resets the processing flag on the error path.
func (q *ChunkQueue) AgentDone() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.processing = false
}

func joinChunks(chunks []chunk) Batch {
	texts := make([]string, len(chunks))
	for i, c := range chunks {
		texts[i] = c.text
	}
	return Batch{
		Text:     strings.Join(texts, " "),
		EditMode: chunks[0].editMode,
	}
}

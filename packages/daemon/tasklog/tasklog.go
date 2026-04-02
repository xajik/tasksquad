package tasklog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// TaskLog is an append-only JSONL writer for a single task's lifecycle events.
// All methods are goroutine-safe.
type TaskLog struct {
	mu sync.Mutex
	f  *os.File
}

// Open creates (or appends to) ~/.tasksquad/tasks/<taskID>.jsonl.
func Open(taskID string) (*TaskLog, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(home, ".tasksquad", "tasks")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, taskID+".jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	return &TaskLog{f: f}, nil
}

// Write appends one JSON line atomically.
func (t *TaskLog) Write(event any) error {
	b, err := json.Marshal(event)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	t.mu.Lock()
	defer t.mu.Unlock()
	_, err = t.f.Write(b)
	return err
}

// Close flushes and closes the file.
func (t *TaskLog) Close() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.f != nil {
		t.f.Sync() //nolint:errcheck
		t.f.Close()
		t.f = nil
	}
}

// ── Event types ───────────────────────────────────────────────────────────────

// EventTaskStart is written when a task begins execution.
type EventTaskStart struct {
	Type      string `json:"type"`
	TaskID    string `json:"task_id"`
	Agent     string `json:"agent"`
	AgentID   string `json:"agent_id"`
	SessionID string `json:"session_id"`
	Subject   string `json:"subject"`
	LogPath   string `json:"log_path"`
	Ts        string `json:"ts"`
}

// EventMessage is one turn from the initial conversation history.
type EventMessage struct {
	Type string `json:"type"`
	Role string `json:"role"`
	Body string `json:"body"`
	Ts   string `json:"ts"`
}

// EventAgentTurn is written when the agent pauses and awaits user input.
type EventAgentTurn struct {
	Type           string `json:"type"`
	Body           string `json:"body"`
	TranscriptPath string `json:"transcript_path,omitempty"`
	Ts             string `json:"ts"`
}

// EventUserReply is written when the user's reply is delivered to the agent.
type EventUserReply struct {
	Type string `json:"type"`
	Body string `json:"body"`
	Ts   string `json:"ts"`
}

// EventTaskEnd is written when a task finishes (success or failure).
type EventTaskEnd struct {
	Type      string `json:"type"`
	Status    string `json:"status"`
	FinalText string `json:"final_text"`
	R2LogKey  string `json:"r2_log_key,omitempty"`
	Ts        string `json:"ts"`
}

// Now returns the current time formatted as RFC3339.
func Now() string { return time.Now().Format(time.RFC3339) }

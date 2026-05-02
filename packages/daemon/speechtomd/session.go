package speechtomd

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// State tracks the lifecycle of a speech-to-md session.
type State int

const (
	StateIdle         State = iota
	StateInitializing       // agent tmux session starting, awaiting init hook
	StateReady              // agent initialised, record button enabled
	StateRecording          // actively recording and transcribing
	StatePaused             // recording paused, agent still alive
	StateStopped            // session ended
)

func (s State) String() string {
	switch s {
	case StateIdle:
		return "idle"
	case StateInitializing:
		return "initializing"
	case StateReady:
		return "ready"
	case StateRecording:
		return "recording"
	case StatePaused:
		return "paused"
	case StateStopped:
		return "stopped"
	}
	return "unknown"
}

// Session is a single recording session with paired raw-transcript and markdown files.
type Session struct {
	ID      string
	DirPath string
	TxtPath   string // append-only raw transcript
	MdPath    string // actively-rewritten processed markdown
	State     State
	AgentName string
	ModelSize string
}

// NewSession creates the session directory and returns a ready Session.
func NewSession(agentName, modelSize string) (*Session, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	ts := fmt.Sprintf("%d", time.Now().UnixMilli())
	dir := filepath.Join(home, ".tasksquad", "speech-to-markdown", ts)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create session dir: %w", err)
	}
	return &Session{
		ID:      ts,
		DirPath: dir,
		TxtPath:   filepath.Join(dir, ts+".txt"),
		MdPath:    filepath.Join(dir, ts+".md"),
		State:     StateIdle,
		AgentName: agentName,
		ModelSize: modelSize,
	}, nil
}

// AppendTranscript appends a transcript segment to the raw text file.
func (s *Session) AppendTranscript(text string) error {
	f, err := os.OpenFile(s.TxtPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = fmt.Fprintln(f, text)
	return err
}

// ReadMarkdown returns the current markdown content (empty string if not yet created).
func (s *Session) ReadMarkdown() string {
	data, err := os.ReadFile(s.MdPath)
	if err != nil {
		return ""
	}
	return string(data)
}

// WriteMarkdown replaces the markdown file with the given content.
func (s *Session) WriteMarkdown(content string) error {
	return os.WriteFile(s.MdPath, []byte(content), 0644)
}

// ReadTranscript returns the full raw transcript content.
func (s *Session) ReadTranscript() string {
	data, _ := os.ReadFile(s.TxtPath)
	return string(data)
}

// ListSessions returns past session metadata, newest first.
func ListSessions() ([]map[string]any, error) {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".tasksquad", "speech-to-markdown")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var sessions []map[string]any
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		if !e.IsDir() {
			continue
		}
		ts := e.Name()
		sessions = append(sessions, map[string]any{
			"id":       ts,
			"txt_path": filepath.Join(dir, ts, ts+".txt"),
			"md_path":  filepath.Join(dir, ts, ts+".md"),
		})
	}
	return sessions, nil
}

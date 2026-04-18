package ui

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

var (
	voiceMu      sync.Mutex
	voiceContentState string
	voiceFile    string
)

func init() {
	home, _ := os.UserHomeDir()
	notesDir := filepath.Join(home, ".tasksquad", "notes")
	os.MkdirAll(notesDir, 0755)
	voiceFile = filepath.Join(notesDir, "new-document.md")
}

// UpdateVoiceContent updates the current state of the markdown document.
// This is called by the tsq-voice-to-md agent.
func UpdateVoiceContent(content string) {
	voiceMu.Lock()
	defer voiceMu.Unlock()
	voiceContentState = content
	// Also write to disk
	os.WriteFile(voiceFile, []byte(content), 0644)
}

// GetVoiceContent returns the current state for the UI.
func GetVoiceContent() (string, string) {
	voiceMu.Lock()
	defer voiceMu.Unlock()
	return voiceContentState, filepath.Base(voiceFile)
}

// StartVoiceAgent starts a session with tsq-voice-to-md.
func StartVoiceAgent() error {
    // TODO: Implement agent spawning with tsq-voice-to-md instructions
    return nil
}

// ProcessVoiceChunk sends a transcribed chunk to the running agent.
func ProcessVoiceChunk(chunk string) error {
    // TODO: Push to agent's stdin or via API
    return nil
}

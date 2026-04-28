package ui

import (
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/speechtomd"
)

var globalSpeechManager *speechtomd.Manager

// InitSpeechToMD must be called from main before the UI starts.
func InitSpeechToMD(cfg *config.Config) {
	globalSpeechManager = speechtomd.New(cfg)
}

// GetSpeechManager returns the singleton speech-to-md manager. May be nil before
// InitSpeechToMD is called.
func GetSpeechManager() *speechtomd.Manager {
	return globalSpeechManager
}

// GetSpeechContent returns current markdown content and a display file name.
func GetSpeechContent() (string, string) {
	if globalSpeechManager == nil {
		return "", "new-document.md"
	}
	md := globalSpeechManager.Markdown()
	status := globalSpeechManager.Status()
	sessionID, _ := status["session_id"].(string)
	name := "new-document.md"
	if sessionID != "" {
		name = sessionID + ".md"
	}
	return md, name
}

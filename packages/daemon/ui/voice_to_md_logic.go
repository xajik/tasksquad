package ui

import (
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/voicetomd"
)

var globalVoiceManager *voicetomd.Manager

// InitVoiceToMD must be called from main before the UI starts.
func InitVoiceToMD(cfg *config.Config) {
	globalVoiceManager = voicetomd.New(cfg)
}

// GetVoiceManager returns the singleton voice-to-md manager. May be nil before
// InitVoiceToMD is called.
func GetVoiceManager() *voicetomd.Manager {
	return globalVoiceManager
}

// GetVoiceContent returns current markdown content and a display file name.
// Legacy shim kept for compatibility with the dashboard content endpoint.
func GetVoiceContent() (string, string) {
	if globalVoiceManager == nil {
		return "", "new-document.md"
	}
	md := globalVoiceManager.Markdown()
	status := globalVoiceManager.Status()
	sessionID, _ := status["session_id"].(string)
	name := "new-document.md"
	if sessionID != "" {
		name = sessionID + ".md"
	}
	return md, name
}

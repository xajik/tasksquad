package hooks

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/tasksquad/daemon/logger"
)

// VoiceToMDHandler receives voice-to-md lifecycle events from the agent.
type VoiceToMDHandler interface {
	HandleInit()
	HandleResponse(markdown string)
	HandleNotification(transcriptPath string)
}

// handleVoiceToMDInit handles POST /hooks/voice-to-md/init.
// The agent fires this after executing /tsq-voice-to-md to signal it is ready.
func (s *hookServer) handleVoiceToMDInit(w http.ResponseWriter, r *http.Request) {
	if s.voiceHandler == nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	logger.Info("[hooks] POST /hooks/voice-to-md/init — agent ready")
	s.voiceHandler.HandleInit()
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleVoiceToMDResponse handles POST /hooks/voice-to-md/response.
// The agent posts the processed markdown here after each chunk.
func (s *hookServer) handleVoiceToMDResponse(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	logger.Info("[hooks] POST /hooks/voice-to-md/response")

	if s.voiceHandler == nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}

	var payload struct {
		Markdown string `json:"markdown"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.Markdown == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "markdown field required"})
		return
	}

	s.voiceHandler.HandleResponse(payload.Markdown)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleVoiceToMDNotification handles POST /hooks/voice-to-md/notification.
// Fired by each provider after a turn completes (Claude via Notification hook,
// Gemini via AfterAgent hook). Used as a fallback signal to read processed markdown.
func (s *hookServer) handleVoiceToMDNotification(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	logger.Info("[hooks] POST /hooks/voice-to-md/notification")

	if s.voiceHandler == nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}

	var payload struct {
		TranscriptPath string `json:"transcript_path"`
	}
	json.Unmarshal(body, &payload) //nolint:errcheck

	s.voiceHandler.HandleNotification(payload.TranscriptPath)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

package hooks

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	hookadapter "github.com/tasksquad/daemon/adapter"
	"github.com/tasksquad/daemon/logger"
)

// SpeechToMDHandler receives speech-to-md lifecycle events from the agent.
type SpeechToMDHandler interface {
	HandleInit()
	HandleResponse(markdown string)
	// HandleNotification is called when the provider signals a turn is complete.
	// message is the ready-to-use text extracted by the hook handler; empty means
	// the agent has not yet posted a result and no fallback text was available.
	HandleNotification(message string)
}

// handleSpeechToMDInit handles POST /hooks/speech-to-md/init.
// The agent fires this after executing /tsq-speech-to-md to signal it is ready.
func (s *hookServer) handleSpeechToMDInit(w http.ResponseWriter, r *http.Request) {
	if s.speechHandler == nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	logger.Info("[hooks] POST /hooks/speech-to-md/init — agent ready")
	s.speechHandler.HandleInit()
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleSpeechToMDResponse handles POST /hooks/speech-to-md/response.
// The agent posts the processed markdown here after each chunk.
func (s *hookServer) handleSpeechToMDResponse(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	logger.Info("[hooks] POST /hooks/speech-to-md/response")

	if s.speechHandler == nil {
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

	s.speechHandler.HandleResponse(payload.Markdown)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleSpeechToMDNotification handles POST /hooks/speech-to-md/notification.
// Fired by each provider after a turn completes (Claude via Notification hook,
// Gemini via AfterAgent hook, OpenCode via plugin, Codex via notify command).
// Mirrors the adapter-based extraction pattern used in handleStop/handleAfterAgent.
func (s *hookServer) handleSpeechToMDNotification(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	provider := r.URL.Query().Get("provider")
	logger.Info(fmt.Sprintf("[hooks] POST /hooks/speech-to-md/notification provider=%s", provider))

	if s.speechHandler == nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}

	var payload struct {
		TranscriptPath string `json:"transcript_path"`
		Message        string `json:"message"`
	}
	json.Unmarshal(body, &payload) //nolint:errcheck

	message := payload.Message
	if message == "" && payload.TranscriptPath != "" {
		message = hookadapter.For(provider).ExtractTranscript(payload.TranscriptPath)
	}

	s.speechHandler.HandleNotification(message)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

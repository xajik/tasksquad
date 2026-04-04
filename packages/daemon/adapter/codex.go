package adapter

import "encoding/json"

// CodexAdapter handles OpenAI Codex CLI hook payloads.
// Codex delivers its final assistant message via the dedicated /hooks/codex
// endpoint (not /hooks/stop), so ParseStop only handles the failure path.
// Codex has no transcript file; response text comes from SetHookMessage.
type CodexAdapter struct{}

func (CodexAdapter) ParseStop(body []byte, isFailure bool) (StopEvent, error) {
	// Codex uses /hooks/codex for normal completion; /hooks/stop is only reached
	// for the failure=true path (process crash).
	if isFailure {
		var p struct {
			ErrorType      string `json:"error_type"`
			TranscriptPath string `json:"transcript_path"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			return StopEvent{IsFailure: true}, err
		}
		return StopEvent{Reason: p.ErrorType, TranscriptPath: p.TranscriptPath, IsFailure: true}, nil
	}
	return StopEvent{}, nil
}

func (CodexAdapter) ParseNotification(_ []byte) (NotificationEvent, error) {
	return NotificationEvent{}, nil // Codex has no Notification hook
}

func (CodexAdapter) ParseAfterAgent(_ []byte) (AfterAgentEvent, error) {
	return AfterAgentEvent{}, nil
}

// ExtractTranscript returns "" — Codex has no transcript file.
func (CodexAdapter) ExtractTranscript(_ string) string { return "" }

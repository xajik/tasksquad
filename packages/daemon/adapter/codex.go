package adapter

import "encoding/json"

// CodexAdapter reads notify's agent-turn-complete payload. The final response
// is supplied directly, so no private Codex transcript format is needed.
type CodexAdapter struct{}

func (CodexAdapter) ParseStop(body []byte, isFailure bool) (StopEvent, error) {
	var p struct {
		ErrorType      string `json:"error_type"`
		TranscriptPath string `json:"transcript_path"`
		ThreadID       string `json:"thread-id"`
		Message        string `json:"last-assistant-message"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return StopEvent{IsFailure: isFailure}, err
	}
	return StopEvent{Reason: p.ErrorType, TranscriptPath: p.TranscriptPath,
		SessionID: p.ThreadID, HookMessage: p.Message, IsFailure: isFailure}, nil
}
func (CodexAdapter) ParseNotification(_ []byte) (NotificationEvent, error) {
	return NotificationEvent{}, nil
}
func (CodexAdapter) ParseAfterAgent(_ []byte) (AfterAgentEvent, error) { return AfterAgentEvent{}, nil }
func (CodexAdapter) ExtractTranscript(_ string) string                 { return "" }

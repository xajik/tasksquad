package adapter

import "encoding/json"

// OpenCodeAdapter handles sst/opencode hook payloads.
// The tasksquad.ts plugin delivers the clean assistant text in the "message"
// field of the stop hook, so ExtractTranscript is a fallback-only path.
// When transcript_path is present it uses Gemini's single-JSON format.
type OpenCodeAdapter struct{}

func (OpenCodeAdapter) ParseStop(body []byte, isFailure bool) (StopEvent, error) {
	var p struct {
		StopReason     string `json:"stop_reason"`
		Message        string `json:"message"`
		TranscriptPath string `json:"transcript_path"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return StopEvent{IsFailure: isFailure}, err
	}
	return StopEvent{
		Reason:         p.StopReason,
		TranscriptPath: p.TranscriptPath,
		HookMessage:    p.Message, // plugin delivers final text here
		IsFailure:      isFailure || p.StopReason == "error",
	}, nil
}

func (OpenCodeAdapter) ParseNotification(body []byte) (NotificationEvent, error) {
	var p struct {
		Message        string `json:"message"`
		TranscriptPath string `json:"transcript_path"`
	}
	err := json.Unmarshal(body, &p)
	return NotificationEvent{Message: p.Message, TranscriptPath: p.TranscriptPath}, err
}

func (OpenCodeAdapter) ParseAfterAgent(_ []byte) (AfterAgentEvent, error) {
	return AfterAgentEvent{}, nil
}

// ExtractTranscript delegates to GeminiAdapter because OpenCode's transcript
// format is identical to Gemini's single-JSON format.
func (OpenCodeAdapter) ExtractTranscript(path string) string {
	return GeminiAdapter{}.ExtractTranscript(path)
}

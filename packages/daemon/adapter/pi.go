package adapter

import (
	"encoding/json"
	"os"
	"strings"
)

// PiAdapter handles pi.dev hook payloads.
// The tasksquad.ts extension delivers the final assistant text in the "message"
// field of the stop hook, so ExtractTranscript is a fallback-only path.
// When transcript_path is present it uses Gemini's single-JSON format.
type PiAdapter struct{}

func (PiAdapter) ParseStop(body []byte, isFailure bool) (StopEvent, error) {
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
		HookMessage:    p.Message,
		IsFailure:      isFailure || p.StopReason == "error",
	}, nil
}

func (PiAdapter) ParseNotification(body []byte) (NotificationEvent, error) {
	var p struct {
		Message        string `json:"message"`
		TranscriptPath string `json:"transcript_path"`
	}
	err := json.Unmarshal(body, &p)
	return NotificationEvent{Message: p.Message, TranscriptPath: p.TranscriptPath}, err
}

func (PiAdapter) ParseAfterAgent(_ []byte) (AfterAgentEvent, error) {
	return AfterAgentEvent{}, nil
}

// ExtractTranscript reads PI's JSONL session format:
// each line is a JSON object with a "type" field; assistant text lives in
// lines of type "message" where message.role == "assistant".
func (PiAdapter) ExtractTranscript(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := strings.Split(string(data), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		var entry struct {
			Type    string `json:"type"`
			Message struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		if entry.Type != "message" || entry.Message.Role != "assistant" {
			continue
		}
		// content can be a plain string or an array of typed blocks
		var text string
		if json.Unmarshal(entry.Message.Content, &text) == nil {
			return strings.TrimSpace(text)
		}
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(entry.Message.Content, &blocks) == nil {
			var parts []string
			for _, b := range blocks {
				if b.Type == "text" && b.Text != "" {
					parts = append(parts, b.Text)
				}
			}
			if len(parts) > 0 {
				return strings.TrimSpace(strings.Join(parts, "\n"))
			}
		}
	}
	return ""
}

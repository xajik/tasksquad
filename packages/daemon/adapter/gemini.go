package adapter

import (
	"encoding/json"
	"os"
	"strings"
)

// GeminiAdapter handles Google Gemini CLI hook payloads and single-JSON transcripts.
type GeminiAdapter struct{}

func (GeminiAdapter) ParseStop(body []byte, isFailure bool) (StopEvent, error) {
	var p struct {
		Reason         string `json:"reason"`
		TranscriptPath string `json:"transcript_path"`
		PromptResponse string `json:"prompt_response"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return StopEvent{IsFailure: isFailure}, err
	}
	return StopEvent{
		Reason:         p.Reason,
		TranscriptPath: p.TranscriptPath,
		HookMessage:    p.PromptResponse,
		IsFailure:      isFailure || p.Reason == "error",
	}, nil
}

func (GeminiAdapter) ParseNotification(body []byte) (NotificationEvent, error) {
	var p struct {
		Message        string `json:"message"`
		TranscriptPath string `json:"transcript_path"`
	}
	err := json.Unmarshal(body, &p)
	return NotificationEvent{Message: p.Message, TranscriptPath: p.TranscriptPath}, err
}

func (GeminiAdapter) ParseAfterAgent(body []byte) (AfterAgentEvent, error) {
	var p struct {
		TranscriptPath string `json:"transcript_path"`
		PromptResponse string `json:"prompt_response"`
	}
	err := json.Unmarshal(body, &p)
	return AfterAgentEvent{PromptResponse: p.PromptResponse, TranscriptPath: p.TranscriptPath}, err
}

// ExtractTranscript reads Gemini's single-JSON format:
// {"messages": [{"type": "gemini", "content": "..."}, ...]}
// content can be a string or an array of text blocks.
func (GeminiAdapter) ExtractTranscript(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var doc struct {
		Messages []struct {
			Type    string `json:"type"`
			Content any    `json:"content"`
		} `json:"messages"`
	}
	if json.Unmarshal(data, &doc) != nil || len(doc.Messages) == 0 {
		return ""
	}
	for i := len(doc.Messages) - 1; i >= 0; i-- {
		m := doc.Messages[i]
		if m.Type != "gemini" && m.Type != "assistant" {
			continue
		}
		if s, ok := m.Content.(string); ok {
			return strings.TrimSpace(s)
		}
		if list, ok := m.Content.([]any); ok {
			var parts []string
			for _, block := range list {
				if b, ok := block.(map[string]any); ok {
					if text, ok := b["text"].(string); ok && text != "" {
						parts = append(parts, text)
					}
				}
			}
			if len(parts) > 0 {
				return strings.TrimSpace(strings.Join(parts, "\n"))
			}
		}
	}
	return ""
}

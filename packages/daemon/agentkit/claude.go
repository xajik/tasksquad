package agentkit

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
)

// ClaudeAdapter handles Anthropic Claude Code hook payloads and JSONL transcripts.
type ClaudeAdapter struct{}

func (ClaudeAdapter) ParseStop(body []byte, isFailure bool) (StopEvent, error) {
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
	var p struct {
		StopReason     string `json:"stop_reason"`
		TranscriptPath string `json:"transcript_path"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return StopEvent{}, err
	}
	return StopEvent{
		Reason:         p.StopReason,
		TranscriptPath: p.TranscriptPath,
		IsFailure:      p.StopReason == "error",
	}, nil
}

func (ClaudeAdapter) ParseNotification(body []byte) (NotificationEvent, error) {
	var p struct {
		Message        string `json:"message"`
		TranscriptPath string `json:"transcript_path"`
	}
	err := json.Unmarshal(body, &p)
	return NotificationEvent{Message: p.Message, TranscriptPath: p.TranscriptPath}, err
}

func (ClaudeAdapter) ParseAfterAgent(_ []byte) (AfterAgentEvent, error) {
	return AfterAgentEvent{}, nil // Claude does not use AfterAgent
}

// ExtractTranscript reads Claude's JSONL format.
// Each line: {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
func (ClaudeAdapter) ExtractTranscript(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	var lastText string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20) // 1 MiB per line for long assistant messages
	for sc.Scan() {
		var entry struct {
			Type    string `json:"type"`
			Message struct {
				Role    string `json:"role"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &entry) != nil {
			continue
		}
		if entry.Type != "assistant" && entry.Message.Role != "assistant" {
			continue
		}
		var parts []string
		for _, c := range entry.Message.Content {
			if c.Type == "text" && c.Text != "" {
				parts = append(parts, c.Text)
			}
		}
		if len(parts) > 0 {
			lastText = strings.Join(parts, "\n")
		}
	}
	return strings.TrimSpace(lastText)
}

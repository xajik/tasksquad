package adapter

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/tasksquad/daemon/logger"
)

// ClawAdapter handles Claw Code hook payloads and JSONL transcripts.
type ClawAdapter struct{}

func (ClawAdapter) ParseStop(body []byte, isFailure bool) (StopEvent, error) {
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
		StopReason           string `json:"stop_reason"`
		TranscriptPath       string `json:"transcript_path"`
		LastAssistantMessage string `json:"last_assistant_message"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return StopEvent{}, err
	}
	return StopEvent{
		Reason:         p.StopReason,
		TranscriptPath: p.TranscriptPath,
		HookMessage:    p.LastAssistantMessage,
		IsFailure:      p.StopReason == "error",
	}, nil
}

func (ClawAdapter) ParseNotification(body []byte) (NotificationEvent, error) {
	var p struct {
		Message        string `json:"message"`
		TranscriptPath string `json:"transcript_path"`
	}
	err := json.Unmarshal(body, &p)
	return NotificationEvent{Message: p.Message, TranscriptPath: p.TranscriptPath}, err
}

func (ClawAdapter) ParseAfterAgent(_ []byte) (AfterAgentEvent, error) {
	return AfterAgentEvent{}, nil // Claw does not use AfterAgent
}

// ExtractTranscript reads Claw's JSONL format.
// Each line: {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
func (ClawAdapter) ExtractTranscript(path string) string {
	if path == "" {
		logger.Debug("[ClawAdapter] ExtractTranscript: no path provided")
		return ""
	}

	info, err := os.Stat(path)
	if err != nil {
		logger.Debug(fmt.Sprintf("[ClawAdapter] ExtractTranscript: file not found: %s", path))
		return ""
	}
	if info.Size() == 0 {
		logger.Debug(fmt.Sprintf("[ClawAdapter] ExtractTranscript: empty file: %s", path))
		return ""
	}

	f, err := os.Open(path)
	if err != nil {
		logger.Debug(fmt.Sprintf("[ClawAdapter] ExtractTranscript: failed to open: %v", err))
		return ""
	}
	defer f.Close()

	logger.Debug(fmt.Sprintf("[ClawAdapter] ExtractTranscript: reading from %s (%d bytes)", path, info.Size()))

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
	if lastText != "" {
		logger.Debug(fmt.Sprintf("[ClawAdapter] ExtractTranscript: extracted %d chars from transcript", len(lastText)))
	}
	return strings.TrimSpace(lastText)
}

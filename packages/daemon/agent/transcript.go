package agent

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/tasksquad/daemon/adapter"
	"github.com/tasksquad/daemon/logger"
)

// ExtractTranscriptResponse reads a provider-specific conversation transcript and
// returns the text of the last assistant message. Returns empty string on any
// read or parse error so callers can fall back to terminal output.
//
// This package-level function tries Claude (JSONL) first, then Gemini/OpenCode
// (single-JSON), preserving the original behaviour for tests that have no agent context.
// Agent methods should use a.extractTranscriptResponse instead.
func ExtractTranscriptResponse(path string) string {
	if text := (adapter.ClaudeAdapter{}).ExtractTranscript(path); text != "" {
		return text
	}
	return (adapter.GeminiAdapter{}).ExtractTranscript(path)
}

// extractTranscriptResponse delegates to the provider-specific adapter so each
// agent type reads only the format it actually produces.
func (a *Agent) extractTranscriptResponse(path string) string {
	return adapter.For(a.prov.Name()).ExtractTranscript(path)
}

// extractFinalText chooses the best available text for the session's final reply.
// Priority: hook message → transcript file (with retry) → terminal output lines.
// Returns "" for learning sessions (no user-visible reply expected).
func (a *Agent) extractFinalText(hookMsg, transcriptPath string, outputLines []string, wasLearning bool) string {
	if wasLearning {
		return ""
	}

	finalText := hookMsg
	if finalText != "" {
		logger.Info(fmt.Sprintf("[%s] Final text from hook message (%d chars)", a.Config.Name, len(finalText)))
	}

	if finalText == "" && transcriptPath != "" {
		retryDeadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(retryDeadline) {
			finalText = a.extractTranscriptResponse(transcriptPath)
			if finalText != "" {
				logger.Info(fmt.Sprintf("[%s] Final text from transcript (%d chars)", a.Config.Name, len(finalText)))
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		if finalText == "" {
			logger.Warn(fmt.Sprintf("[%s] Transcript read returned empty after 10s, falling back to stored tmux capture", a.Config.Name))
		}
	}

	// Try stored tmux capture file before falling back to outputLines
	if finalText == "" {
		a.st.mu.Lock()
		tmuxPath := a.st.lastTmuxCapturePath
		a.st.mu.Unlock()
		if tmuxPath != "" {
			if data, err := os.ReadFile(tmuxPath); err == nil {
				finalText = strings.TrimSpace(string(data))
				logger.Info(fmt.Sprintf("[%s] Final text from tmux capture file (%d chars)", a.Config.Name, len(finalText)))
			} else {
				logger.Debug(fmt.Sprintf("[%s] Failed to read tmux capture file: %v", a.Config.Name, err))
			}
		}
	}

	if finalText == "" {
		all := strings.Join(outputLines, "\n")
		finalText = strings.TrimSpace(all)
		if len(finalText) > 10000 {
			finalText = finalText[len(finalText)-10000:]
		}
	}

	return finalText
}

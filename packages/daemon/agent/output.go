package agent

import (
	"regexp"
	"strings"

	"github.com/tasksquad/daemon/tmux"
)

// ansiEscape matches ANSI/VT100 escape sequences produced by terminal UIs.
var ansiEscape = regexp.MustCompile(`\x1b(\[[0-9;?]*[A-Za-z]|\][^\x07]*(\x07|\x1b\\)|\(B|[0-9A-Za-z])`)

// cleanLine strips ANSI escape sequences and handles carriage returns (\r).
// PTY output from TUI programs like Claude Code uses \r to overwrite the
// current line; we take only the segment after the last \r so the log
// contains the final visible content of each line.
func cleanLine(s string) string {
	if i := strings.LastIndex(s, "\r"); i >= 0 {
		s = s[i+1:]
	}
	return strings.TrimRight(ansiEscape.ReplaceAllString(s, ""), " \t")
}

// buildNotifyMessage extracts Claude's actual question/response from the terminal.
// The Notification hook only delivers a generic string ("Claude is waiting for
// your input"); the real question text lives in the terminal output.
//
// For the tmux path: use `tmux capture-pane` to read the current *visible*
// terminal content — far more reliable than the raw FIFO byte stream whose
// full-screen TUI redraws collapse to empty strings after ANSI cleanup.
// For the PTY path: fall back to the last 15 non-empty output lines from
// streamOutput.
func buildNotifyMessage(a *Agent, fallback string) string {
	a.st.mu.Lock()
	sess := a.st.tmuxSession
	lines := append([]string(nil), a.st.outputLines...)
	prompt := a.st.lastPrompt
	a.st.mu.Unlock()

	var visible []string

	if sess != "" && tmuxBin != "" {
		if out := tmux.CapturePane(sess, 200); out != "" {
			for _, raw := range strings.Split(out, "\n") {
				if s := strings.TrimSpace(cleanLine(raw)); s != "" {
					visible = append(visible, s)
				}
			}
		}
	} else {
		// PTY / fallback path: use the captured output lines.
		for _, raw := range lines {
			if s := strings.TrimSpace(raw); s != "" {
				visible = append(visible, s)
			}
		}
	}

	if len(visible) == 0 {
		return fallback
	}

	// Filter out lines that look like echoes of the prompt.
	var filtered []string
	cleanPrompt := strings.TrimSpace(prompt)
	for _, line := range visible {
		isPrompt := false
		if cleanPrompt != "" {
			if strings.Contains(line, cleanPrompt) || strings.Contains(cleanPrompt, line) {
				isPrompt = true
			}
		}
		if !isPrompt {
			filtered = append(filtered, line)
		}
	}

	if len(filtered) > 15 {
		filtered = filtered[len(filtered)-15:]
	}
	if len(filtered) > 0 {
		return strings.Join(filtered, "\n")
	}

	// If everything was filtered out, the agent hasn't produced anything yet
	// except echoing the prompt. Fall back to the original message.
	return fallback
}

package tmux

import (
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const tmuxBin = "tmux"

// SessionReadyWait is how long to wait after starting a tmux session before
// sending the initial prompt. CLI tools (Claude Code, Gemini, etc.) need time
// to initialise their TUI before they can accept keyboard input.
const SessionReadyWait = 5 * time.Second

// SubmitWait is how long to wait between sending prompt text and sending Enter.
// Two separate send-keys calls are required — merging them causes Claude's TUI
// to miss the Enter keystroke.
const SubmitWait = 2 * time.Second

// WaitForReady sleeps SessionReadyWait to let a freshly started tmux session
// fully initialise before any input is sent.
func WaitForReady() {
	time.Sleep(SessionReadyWait)
}

// SendKeys sends text to a tmux session, waits SubmitWait, then sends Enter
// (C-m) as a separate call. Use for single-line prompts or keypress replies.
func SendKeys(session, text string) error {
	if err := exec.Command(tmuxBin, "send-keys", "-t", session, text).Run(); err != nil {
		return err
	}
	time.Sleep(SubmitWait)
	return exec.Command(tmuxBin, "send-keys", "-t", session, "C-m").Run()
}

// SendEnter sends only Enter (C-m) to a tmux session — use when there is no
// text to type first (e.g. arrow-key menus, empty-input confirmations).
func SendEnter(session string) error {
	return exec.Command(tmuxBin, "send-keys", "-t", session, "C-m").Run()
}

// PastePromptFile loads a file into a named tmux buffer, pastes it into the
// session (avoiding shell-quoting issues with multi-line text), waits
// SubmitWait, then sends Enter. Call WaitForReady() before this.
func PastePromptFile(session, bufName, promptFile string) error {
	if err := exec.Command(tmuxBin, "load-buffer", "-b", bufName, promptFile).Run(); err != nil {
		return err
	}
	if err := exec.Command(tmuxBin, "paste-buffer", "-b", bufName, "-t", session).Run(); err != nil {
		return err
	}
	time.Sleep(SubmitWait)
	return exec.Command(tmuxBin, "send-keys", "-t", session, "C-m").Run()
}

// DeleteBuffer removes a named tmux buffer.
func DeleteBuffer(bufName string) {
	exec.Command(tmuxBin, "delete-buffer", "-b", bufName).Run() //nolint:errcheck
}

// HasSession reports whether a tmux session with the given name currently exists.
func HasSession(name string) bool {
	return exec.Command(tmuxBin, "has-session", "-t", name).Run() == nil
}

// CapturePane returns the last n lines of visible output from a tmux session.
// Returns an empty string if the session does not exist or capture fails.
func CapturePane(session string, lines int) string {
	out, err := exec.Command(tmuxBin, "capture-pane", "-t", session, "-p",
		"-S", fmt.Sprintf("-%d", lines)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

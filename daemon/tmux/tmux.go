package tmux

import (
	"fmt"
	"os/exec"
	"strings"
)

func run(args ...string) error {
	return exec.Command("tmux", args...).Run()
}

func output(args ...string) (string, error) {
	out, err := exec.Command("tmux", args...).Output()
	return string(out), err
}

// EnsureSession creates the tmux session if it doesn't already exist.
func EnsureSession(name, workDir string) error {
	// Check if session exists
	if err := run("has-session", "-t", name); err == nil {
		return nil
	}
	return run("new-session", "-d", "-s", name, "-c", workDir)
}

// SendKeys sends text followed by Enter to the named session.
func SendKeys(session, text string) error {
	return run("send-keys", "-t", session, text, "Enter")
}

// PipeToFile redirects session output to a file via pipe-pane.
func PipeToFile(session, path string) error {
	return run("pipe-pane", "-t", session, "-o", fmt.Sprintf("cat >> %s", path))
}

// StopPipe stops the pipe-pane for the session.
func StopPipe(session string) error {
	return run("pipe-pane", "-t", session)
}

// CapturePane returns the visible content of the session pane.
func CapturePane(session string) string {
	out, err := output("capture-pane", "-p", "-t", session)
	if err != nil {
		return ""
	}
	return strings.TrimRight(out, "\n")
}

// KillSession kills the named tmux session.
func KillSession(session string) error {
	return run("kill-session", "-t", session)
}

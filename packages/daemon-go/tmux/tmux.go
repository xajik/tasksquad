package tmux

import (
	"os/exec"
	"strings"
)

func EnsureSession(name, workDir string) error {
	if HasSession(name) {
		return nil
	}
	cmd := exec.Command("tmux", "new-session", "-d", "-s", name, "-c", workDir)
	return cmd.Run()
}

func SendKeys(session, text string) error {
	text = strings.ReplaceAll(text, "'", "'\\''")
	cmd := exec.Command("tmux", "send-keys", "-t", session, text, "Enter")
	return cmd.Run()
}

func PipeToFile(session, logPath string) error {
	cmd := exec.Command("tmux", "pipe-pane", "-t", session, "-o", "cat >> "+logPath)
	return cmd.Run()
}

func StopPipe(session string) error {
	cmd := exec.Command("tmux", "pipe-pane", "-t", session)
	return cmd.Run()
}

func CapturePane(session string) (string, error) {
	cmd := exec.Command("tmux", "capture-pane", "-t", session, "-p")
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(output), nil
}

func KillSession(session string) error {
	cmd := exec.Command("tmux", "kill-session", "-t", session)
	return cmd.Run()
}

func HasSession(session string) bool {
	cmd := exec.Command("tmux", "has-session", "-t", session)
	return cmd.Run() == nil
}

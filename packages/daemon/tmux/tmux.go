package tmux

import (
	"os/exec"
	"time"
)

const tmuxBin = "tmux"

// SendKeys sends text to a tmux session, then waits 2 seconds before sending
// Enter (C-m) as a separate action. These MUST be two separate send-keys calls —
// merging them into one command causes Claude's TUI to miss the Enter keystroke.
func SendKeys(session, text string) error {
	if err := exec.Command(tmuxBin, "send-keys", "-t", session, text).Run(); err != nil {
		return err
	}
	time.Sleep(2 * time.Second)
	return exec.Command(tmuxBin, "send-keys", "-t", session, "C-m").Run()
}

// SendEnter sends only Enter (C-m) to a tmux session — use when there is no
// text to type first (e.g. arrow-key menus, empty-input confirmations).
func SendEnter(session string) error {
	return exec.Command(tmuxBin, "send-keys", "-t", session, "C-m").Run()
}

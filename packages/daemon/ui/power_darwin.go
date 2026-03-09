//go:build darwin

package ui

import (
	"fmt"
	"os/exec"
)

type wakelock struct{ cmd *exec.Cmd }

// acquireWakelock runs `caffeinate -i` to prevent the system from sleeping
// while the daemon is actively pulling tasks.
func acquireWakelock() *wakelock {
	cmd := exec.Command("caffeinate", "-i")
	if err := cmd.Start(); err != nil {
		fmt.Printf("[ui] wakelock: caffeinate failed: %v\n", err)
		return &wakelock{}
	}
	return &wakelock{cmd: cmd}
}

func (w *wakelock) Release() {
	if w.cmd != nil && w.cmd.Process != nil {
		_ = w.cmd.Process.Kill()
	}
}

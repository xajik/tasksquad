//go:build linux

package ui

import (
	"fmt"
	"os/exec"
)

type wakelock struct{ cmd *exec.Cmd }

// acquireWakelock uses systemd-inhibit to prevent idle sleep while pulling.
func acquireWakelock() *wakelock {
	cmd := exec.Command("systemd-inhibit",
		"--what=sleep:idle",
		"--who=tsq",
		"--why=TaskSquad agent pulling tasks",
		"--mode=block",
		"sleep", "infinity",
	)
	if err := cmd.Start(); err != nil {
		fmt.Printf("[ui] wakelock: systemd-inhibit not available: %v\n", err)
		return &wakelock{}
	}
	return &wakelock{cmd: cmd}
}

func (w *wakelock) Release() {
	if w.cmd != nil && w.cmd.Process != nil {
		_ = w.cmd.Process.Kill()
	}
}

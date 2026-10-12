//go:build !windows

package agent

import (
	"os/exec"
	"syscall"
	"time"
)

// newProcessGroup starts a pipe provider in its own process group, so ending
// the task also ends the tools it spawned (a bash `sleep` would otherwise
// outlive the task and hold the stdout pipe open).
func newProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// terminateProcessGroup sends SIGTERM to the group led by pid, then SIGKILL to
// whatever is left after a grace period.
func terminateProcessGroup(pid int) {
	if pid <= 0 {
		return
	}
	syscall.Kill(-pid, syscall.SIGTERM) //nolint:errcheck
	go func() {
		time.Sleep(3 * time.Second)
		syscall.Kill(-pid, syscall.SIGKILL) //nolint:errcheck
	}()
}

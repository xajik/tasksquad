//go:build windows

package agent

import (
	"os"
	"os/exec"
)

func newProcessGroup(_ *exec.Cmd) {}

// terminateProcessGroup ends the provider process itself; Windows has no
// process groups to signal here.
func terminateProcessGroup(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		p.Kill() //nolint:errcheck
	}
}

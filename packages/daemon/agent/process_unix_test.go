//go:build !windows

package agent

import (
	"errors"
	"io"
	"os/exec"
	"syscall"
	"testing"
	"time"

	"github.com/tasksquad/daemon/agentmode"
	"github.com/tasksquad/daemon/config"
)

// startPipeProvider runs a stand-in pipe provider whose tool child (sleep)
// inherits stdout, as Pi's bash tool does.
func startPipeProvider(t *testing.T) (int, chan struct{}) {
	t.Helper()
	cmd := exec.Command("/bin/sh", "-c", "sleep 300 & wait")
	newProcessGroup(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	outputDone := make(chan struct{})
	go func() { io.Copy(io.Discard, stdout); close(outputDone) }()        //nolint:errcheck
	go cmd.Wait()                                                         //nolint:errcheck
	t.Cleanup(func() { syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }) //nolint:errcheck
	return cmd.Process.Pid, outputDone
}

func groupGone(pid int) bool {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(-pid, 0); errors.Is(err, syscall.ESRCH) {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func TestCancelledPipeTaskTerminatesProviderAndToolChildren(t *testing.T) {
	a := &Agent{Config: config.AgentConfig{Name: "pi"}}
	pid, outputDone := startPipeProvider(t)
	started := time.Now()
	a.closeProcessResources(string(agentmode.StatusCancelled), "", "", nil, pid, outputDone)
	if waited := time.Since(started); waited > 5*time.Second {
		t.Fatalf("cancel waited %s for the output drain; the group should be terminated at once", waited)
	}
	if !groupGone(pid) {
		t.Fatal("provider or its tool child survived the cancelled task")
	}
}

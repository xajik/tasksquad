//go:build windows

package agent

import (
	"errors"
	"os"
)

func mkfifo(_ string, _ uint32) error {
	return errors.New("mkfifo not supported on Windows")
}

// setBlocking is unreachable in practice: mkfifo above always errors first,
// so handlePortal never gets far enough to open a FIFO on Windows. It exists
// only so portal.go compiles for this platform.
func setBlocking(_ *os.File) error {
	return nil
}

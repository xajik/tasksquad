//go:build !windows

package agent

import (
	"os"
	"syscall"
)

func mkfifo(path string, mode uint32) error {
	return syscall.Mkfifo(path, mode)
}

// setBlocking switches f back to blocking I/O mode. See the comment at its
// call site in portal.go for why this matters.
func setBlocking(f *os.File) error {
	return syscall.SetNonblock(int(f.Fd()), false)
}

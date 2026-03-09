//go:build !windows

package agent

import "syscall"

func mkfifo(path string, mode uint32) error {
	return syscall.Mkfifo(path, mode)
}

//go:build windows

package agent

import "errors"

func mkfifo(_ string, _ uint32) error {
	return errors.New("mkfifo not supported on Windows")
}

//go:build windows

package ui

import "syscall"

var (
	kernel32           = syscall.NewLazyDLL("kernel32.dll")
	setThreadExecState = kernel32.NewProc("SetThreadExecutionState")
)

const (
	esSystemRequired = 0x00000001
	esContinuous     = 0x80000000
)

type wakelock struct{}

// acquireWakelock calls SetThreadExecutionState to prevent the system from sleeping.
func acquireWakelock() *wakelock {
	setThreadExecState.Call(uintptr(esContinuous | esSystemRequired))
	return &wakelock{}
}

func (w *wakelock) Release() {
	setThreadExecState.Call(uintptr(esContinuous))
}

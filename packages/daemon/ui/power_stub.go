//go:build !darwin && !linux && !windows

package ui

// wakelock is a no-op on unsupported platforms.
type wakelock struct{}

func acquireWakelock() *wakelock { return &wakelock{} }
func (w *wakelock) Release()     {}

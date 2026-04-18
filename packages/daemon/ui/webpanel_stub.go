//go:build !cgo || !darwin

package ui

import (
	"os/exec"
	"runtime"

	"github.com/tasksquad/daemon/logger"
)

// openControlPanel falls back to the system browser on non-macOS platforms.
func openControlPanel(url string) {
	var cmd string
	switch runtime.GOOS {
	case "linux":
		cmd = "xdg-open"
	default:
		logger.Warn("[ui] openControlPanel: unsupported OS")
		return
	}
	if err := exec.Command(cmd, url).Start(); err != nil {
		logger.Warn("[ui] openControlPanel: " + err.Error())
	}
}

// openVoiceToMD falls back to the system browser on non-macOS platforms.
func openVoiceToMD(url string) {
	openControlPanel(url)
}

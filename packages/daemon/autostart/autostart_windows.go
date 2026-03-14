//go:build windows

// Package autostart manages registering the tsq daemon to start on OS boot.
package autostart

import (
	"fmt"
	"os"
	"path/filepath"
)

func startupPath() (string, error) {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return "", fmt.Errorf("APPDATA environment variable not set")
	}
	return filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "tsq.bat"), nil
}

// IsEnabled returns true if the startup batch file exists.
func IsEnabled() bool {
	p, err := startupPath()
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

// Enable creates a batch file in the Windows Startup folder so the daemon
// launches automatically when the user logs in.
func Enable(execPath string) error {
	p, err := startupPath()
	if err != nil {
		return err
	}
	content := fmt.Sprintf("@echo off\nstart \"\" \"%s\"\n", execPath)
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		return fmt.Errorf("write startup file: %w", err)
	}
	return nil
}

// Disable removes the batch file from the Windows Startup folder.
func Disable() error {
	p, err := startupPath()
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove startup file: %w", err)
	}
	return nil
}

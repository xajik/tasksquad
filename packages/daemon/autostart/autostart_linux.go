//go:build linux

// Package autostart manages registering the tsq daemon to start on OS boot.
package autostart

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"text/template"
)

var desktopTmpl = template.Must(template.New("desktop").Parse(`[Desktop Entry]
Type=Application
Name=TaskSquad Daemon
Comment=TaskSquad AI agent daemon
Exec={{.ExecPath}}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`))

func desktopPath() (string, error) {
	// Respect XDG_CONFIG_HOME if set.
	configDir := os.Getenv("XDG_CONFIG_HOME")
	if configDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		configDir = filepath.Join(home, ".config")
	}
	return filepath.Join(configDir, "autostart", "tsq.desktop"), nil
}

// IsEnabled returns true if the XDG autostart .desktop file exists.
func IsEnabled() bool {
	p, err := desktopPath()
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

// Enable writes the XDG autostart .desktop file so the daemon is launched by
// the desktop session manager on login (GNOME, KDE, XFCE, etc.).
func Enable(execPath string) error {
	p, err := desktopPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		return fmt.Errorf("mkdir autostart: %w", err)
	}
	var buf bytes.Buffer
	if err := desktopTmpl.Execute(&buf, struct{ ExecPath string }{execPath}); err != nil {
		return fmt.Errorf("desktop template: %w", err)
	}
	if err := os.WriteFile(p, buf.Bytes(), 0644); err != nil {
		return fmt.Errorf("write desktop file: %w", err)
	}
	return nil
}

// Disable removes the XDG autostart .desktop file.
func Disable() error {
	p, err := desktopPath()
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove desktop file: %w", err)
	}
	return nil
}

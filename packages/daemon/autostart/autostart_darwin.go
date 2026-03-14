//go:build darwin

// Package autostart manages registering the tsq daemon to start on OS boot.
package autostart

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"text/template"
)

const labelID = "ai.tasksquad.tsq"

var plistTmpl = template.Must(template.New("plist").Parse(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{{.Label}}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{{.ExecPath}}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<false/>
	<key>StandardOutPath</key>
	<string>{{.LogPath}}</string>
	<key>StandardErrorPath</key>
	<string>{{.LogPath}}</string>
</dict>
</plist>
`))

func plistPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", labelID+".plist"), nil
}

// IsEnabled returns true if the LaunchAgent plist file exists.
func IsEnabled() bool {
	p, err := plistPath()
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

// Enable writes the LaunchAgent plist and loads it with launchctl so it takes
// effect immediately and on every subsequent login.
func Enable(execPath string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	p, err := plistPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		return fmt.Errorf("mkdir LaunchAgents: %w", err)
	}
	logPath := filepath.Join(home, ".tasksquad", "logs", "launchd.log")
	var buf bytes.Buffer
	if err := plistTmpl.Execute(&buf, struct {
		Label    string
		ExecPath string
		LogPath  string
	}{labelID, execPath, logPath}); err != nil {
		return fmt.Errorf("plist template: %w", err)
	}
	if err := os.WriteFile(p, buf.Bytes(), 0644); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}
	// Load so it takes effect in the current login session too.
	if out, err := exec.Command("launchctl", "load", "-w", p).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl load: %w (%s)", err, bytes.TrimSpace(out))
	}
	return nil
}

// Disable unloads the LaunchAgent and removes the plist file.
func Disable() error {
	p, err := plistPath()
	if err != nil {
		return err
	}
	// Unload — ignore errors if the job is not currently loaded.
	exec.Command("launchctl", "unload", "-w", p).Run() //nolint:errcheck
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove plist: %w", err)
	}
	return nil
}

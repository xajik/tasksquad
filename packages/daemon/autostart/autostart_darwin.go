//go:build darwin

// Package autostart manages registering the tsq daemon to start on OS boot.
package autostart

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"text/template"
)

const labelID = "ai.tasksquad.tsq"

var plistTmpl = template.Must(template.New("plist").Funcs(template.FuncMap{
	"xml": func(value string) string {
		var b bytes.Buffer
		xml.EscapeText(&b, []byte(value))
		return b.String()
	},
}).Parse(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{{.Label}}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{{.ExecPath | xml}}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<false/>
	<key>StandardOutPath</key>
	<string>{{.LogPath | xml}}</string>
	<key>StandardErrorPath</key>
	<string>{{.LogPath | xml}}</string>
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

// Enable registers the next login. Loading a RunAtLoad job here would launch a
// second daemon alongside the process whose menu is enabling autostart.
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
	if err := os.MkdirAll(filepath.Dir(logPath), 0755); err != nil {
		return fmt.Errorf("mkdir logs: %w", err)
	}
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
	return nil
}

// Disable removes registration for the next login. Unloading here would kill
// this process when it was itself started by launchd, before removing the plist.
func Disable() error {
	p, err := plistPath()
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove plist: %w", err)
	}
	return nil
}

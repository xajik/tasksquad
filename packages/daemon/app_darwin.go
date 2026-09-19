//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"al.essio.dev/pkg/shellescape"
	"github.com/tasksquad/daemon/config"
)

func appBundle(executable string) string {
	dir := filepath.Dir(executable)
	if filepath.Base(dir) != "MacOS" || filepath.Base(filepath.Dir(dir)) != "Contents" {
		return ""
	}
	bundle := filepath.Dir(filepath.Dir(dir))
	if !strings.HasSuffix(bundle, ".app") {
		return ""
	}
	return bundle
}

func appSearchPath(executable, home, inherited string) string {
	// Finder and launchd do not inherit a terminal's PATH. Include both brew
	// prefixes and common user installs; keep explicitly configured paths first.
	paths := []string{filepath.Dir(executable)}
	paths = append(paths, filepath.SplitList(inherited)...)
	paths = append(paths, "/opt/homebrew/bin", "/usr/local/bin",
		filepath.Join(home, ".local", "bin"), filepath.Join(home, ".bun", "bin"),
		filepath.Join(home, ".cargo", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin")
	seen := map[string]bool{}
	var result []string
	for _, path := range paths {
		if filepath.IsAbs(path) && !seen[path] {
			result = append(result, path)
			seen[path] = true
		}
	}
	return strings.Join(result, string(os.PathListSeparator))
}

func prepareAppEnvironment() {
	executable, _ := os.Executable()
	if appBundle(executable) == "" {
		return
	}
	home, _ := os.UserHomeDir()
	os.Setenv("PATH", appSearchPath(executable, home, os.Getenv("PATH")))
}

// The app and CLI share credentials, hooks, and task state. Keep a lock for the
// process lifetime so opening either cannot start duplicate task pollers.
func acquireDaemonLock(dir string) (func(), error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("TaskSquad is already running, or its daemon lock is unavailable. Quit the running app or CLI daemon before starting another: %w", err)
	}
	// Do not unlink: waiting/new processes must all lock the same inode.
	return func() { f.Close() }, nil
}

func setupCommand(executable, bundle string) string {
	return "#!/bin/sh\nrm -- \"$0\"\n" + shellescape.Quote(executable) +
		" init && /usr/bin/open -a " + shellescape.Quote(bundle) + "\n"
}

// The existing setup wizard is interactive. Finder has no stdin, so open it
// in Terminal and relaunch the app only after setup succeeds.
func startAppSetup(configPath string) (bool, error) {
	executable, _ := os.Executable()
	bundle := appBundle(executable)
	if bundle == "" || configPath != config.DefaultPath() {
		return false, nil
	}
	if _, err := os.Stat(configPath); !os.IsNotExist(err) {
		return false, nil
	}
	f, err := os.CreateTemp("", "tasksquad-setup-*.command")
	if err != nil {
		return false, err
	}
	name := f.Name()
	_, err = f.WriteString(setupCommand(executable, bundle))
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(name, 0700)
	}
	if err == nil {
		err = exec.Command("/usr/bin/open", "-a", "Terminal", name).Run()
	}
	if err != nil {
		os.Remove(name)
		return false, fmt.Errorf("open TaskSquad setup: %w", err)
	}
	return true, nil
}

func startupError(err error) {
	fmt.Fprintln(os.Stderr, err)
	executable, _ := os.Executable()
	if appBundle(executable) != "" {
		// Pass the message as an argument, never interpolate it into AppleScript.
		exec.Command("/usr/bin/osascript", "-e", `on run argv
display alert "TaskSquad could not start" message (item 1 of argv) as critical
end run`, err.Error()).Run()
	}
}

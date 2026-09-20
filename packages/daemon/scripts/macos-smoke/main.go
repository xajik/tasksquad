// A manual UI fixture using the real tray and control panel with no live agents.
package main

import (
	"os"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/tasksquad/daemon/ui"
)

type controls struct {
	paused atomic.Bool
	boot   atomic.Bool
	dir    string
}

func (c *controls) IsPaused() bool                   { return c.paused.Load() }
func (c *controls) Pause()                           { c.paused.Store(true) }
func (c *controls) Resume()                          { c.paused.Store(false) }
func (c *controls) IsEnabled() bool                  { return c.boot.Load() }
func (c *controls) Enable() error                    { c.boot.Store(true); return nil }
func (c *controls) Disable() error                   { c.boot.Store(false); return nil }
func (*controls) Email() string                      { return "smoke-test@example.invalid" }
func (*controls) Logout() error                      { return nil }
func (c *controls) CloseActivePortals(time.Duration) { os.RemoveAll(c.dir) }
func (*controls) ForceSync()                         {}
func (*controls) ForcePoll()                         {}

func main() {
	dir, err := os.MkdirTemp("", "tasksquad-ui-smoke-")
	if err != nil {
		panic(err)
	}
	configPath := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(configPath, []byte("# TaskSquad UI smoke fixture\n"), 0600); err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)
	c := &controls{dir: dir}
	c.paused.Store(true)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signals
		os.RemoveAll(dir)
		os.Exit(0)
	}()
	ui.Run(nil, c, c, c, c, c, c, "http://127.0.0.1", configPath, "SMOKE TEST", 0)
}

// Headless local development entry point using the shipping daemon engine.
// Authentication storage is process-local; it never accesses the login Keychain.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/tasksquad/daemon/agent"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/hooks"
	"github.com/tasksquad/daemon/logger"
	"github.com/zalando/go-keyring"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	cfgPath := flag.String("config", "", "local config path")
	sessionPath := flag.String("session", "", "local session JSON path")
	flag.Parse()
	if !filepath.IsAbs(os.Getenv("TSQ_STATE_DIR")) {
		return fmt.Errorf("TSQ_STATE_DIR must be an absolute isolated directory")
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}
	u, err := url.Parse(cfg.Server.URL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil {
		return fmt.Errorf("local daemon requires an http://127.0.0.1 API")
	}
	var session struct {
		Token string `json:"token"`
	}
	data, err := os.ReadFile(*sessionPath)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, &session); err != nil {
		return err
	}
	if len(session.Token) != 72 || session.Token[:8] != "tsq_cli_" {
		return fmt.Errorf("invalid local CLI token")
	}
	keyring.MockInit()
	if err := keyring.Set("tasksquad-daemon", "cli-token", session.Token); err != nil {
		return err
	}
	if err := keyring.Set("tasksquad-daemon", "cli-token-expiry", time.Now().Add(30*24*time.Hour).Format(time.RFC3339)); err != nil {
		return err
	}

	if err := logger.Init(); err != nil {
		return err
	}
	agents := make([]*agent.Agent, 0, len(cfg.Agents))
	hookAgents := make([]hooks.Agent, 0, len(cfg.Agents))
	for _, ac := range cfg.Agents {
		a := agent.New(ac)
		agents = append(agents, a)
		hookAgents = append(hookAgents, a)
	}
	ctrl := agent.NewBatchController()
	if err := hooks.StartHookServer(cfg, hookAgents, nil, ctrl); err != nil {
		return err
	}
	go agent.RunBatch(cfg, agents, ctrl)
	logger.Info("Local Go daemon: real heartbeat, assignment, provider execution and session callbacks")
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)
	for {
		select {
		case <-done:
			for _, a := range agents {
				a.Pause()
				if a.SessionID() != "" {
					a.Complete(cfg, "cancelled", "")
				}
			}
			return nil
		}
	}
}

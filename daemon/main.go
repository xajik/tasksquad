package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/tasksquad/daemon/agent"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/hooks"
)

func main() {
	cfgPath := flag.String("config", config.DefaultPath(), "path to config.toml")
	apiURL := flag.String("api-url", "", "override API URL from config")
	version := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *version {
		fmt.Println("tsq 0.1.0")
		os.Exit(0)
	}

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error loading config: %v\n", err)
		os.Exit(1)
	}
	if *apiURL != "" {
		cfg.Server.URL = *apiURL
	}

	// Build agent map
	agentMap := make(map[string]*agent.Agent)
	agentList := make([]*agent.Agent, 0, len(cfg.Agents))
	for _, ac := range cfg.Agents {
		a := agent.New(ac.ID, ac)
		agentMap[ac.ID] = a
		agentList = append(agentList, a)
	}

	// Start agent goroutines
	for _, a := range agentList {
		go a.Run(cfg)
	}

	// Start hook server in background
	go hooks.StartHookServer(cfg, agentMap)

	// TODO: start systray on main thread (requires CGO; disabled for now)
	// ui.RunSystray(agentList, func() {}, func() {})

	// Block forever (systray would own this thread on macOS)
	select {}
}

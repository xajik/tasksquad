package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/tasksquad/daemon/agent"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/hooks"
	"github.com/tasksquad/daemon/logger"
)

const version = "0.1.0"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "init" {
		runInit()
		return
	}

	cfgPath := flag.String("config", config.DefaultPath(), "path to config.toml")
	apiURL := flag.String("api-url", "", "override API URL from config")
	ver := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *ver {
		fmt.Println("tsq " + version)
		return
	}

	if err := logger.Init(); err != nil {
		fmt.Fprintf(os.Stderr, "logger init error: %v\n", err)
		os.Exit(1)
	}

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error loading config: %v\n", err)
		os.Exit(1)
	}
	if *apiURL != "" {
		cfg.Server.URL = *apiURL
	}

	logger.Info("TaskSquad daemon starting")
	logger.Info(fmt.Sprintf("API: %s", cfg.Server.URL))
	logger.Info(fmt.Sprintf("Poll interval: %ds", cfg.Server.PollInterval))

	// Build agents
	agentList := make([]hooks.Agent, 0, len(cfg.Agents))
	for _, ac := range cfg.Agents {
		a := agent.New(ac)
		agentList = append(agentList, a)
		logger.Info(fmt.Sprintf("  - %s (command: %s)", ac.Name, ac.Command))
	}

	// Start hook server (receives Claude Code Stop + Notification events)
	hooks.StartHookServer(cfg, agentList)

	// Start each agent's poll loop
	for _, a := range agentList {
		go a.(*agent.Agent).Run(cfg)
	}

	logger.Info("Running — waiting for tasks...")

	// Block forever (systray would own this thread in future)
	select {}
}

// runInit is a guided wizard that writes ~/.tasksquad/config.toml.
func runInit() {
	scanner := bufio.NewScanner(os.Stdin)

	read := func(prompt, def string) string {
		if def != "" {
			fmt.Printf("%s [%s]: ", prompt, def)
		} else {
			fmt.Printf("%s: ", prompt)
		}
		scanner.Scan()
		v := strings.TrimSpace(scanner.Text())
		if v == "" {
			return def
		}
		return v
	}

	fmt.Println("TaskSquad daemon setup")
	fmt.Println("----------------------")

	apiURL := read("API URL", "https://tasksquad-api.xajik0.workers.dev")
	token := read("Agent token (paste from portal)", "")
	name := read("Agent name", "my-agent")
	command := read("CLI command", "claude")
	workDir := read("Work directory", "~/Projects")
	port := read("Hooks port", "7374")

	toml := fmt.Sprintf(`[server]
url = %q
poll_interval = 30

[hooks]
port = %s

[[agents]]
token = %q
name = %q
command = %q
work_dir = %q
`, apiURL, port, token, name, command, workDir)

	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".tasksquad")
	os.MkdirAll(dir, 0755)
	path := filepath.Join(dir, "config.toml")

	if err := os.WriteFile(path, []byte(toml), 0600); err != nil {
		fmt.Fprintf(os.Stderr, "error writing config: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("\nConfig written to %s\n", path)
	fmt.Println("Run: tsq")

	// Also print a sample JSON config for reference (matches old TS format)
	sample, _ := json.MarshalIndent(map[string]any{
		"apiUrl":       apiURL,
		"pollInterval": 30,
		"hooksPort":    7374,
		"agents": []map[string]any{{
			"token":   token,
			"name":    name,
			"command": command,
			"workDir": workDir,
		}},
	}, "", "  ")
	_ = sample
}

package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/tasksquad/daemon/agent"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/hooks"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/provider"
	"github.com/tasksquad/daemon/ui"
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

	logger.Info("TaskSquad daemon starting — tsq " + version)
	logger.Info(fmt.Sprintf("API: %s", cfg.Server.URL))
	logger.Info(fmt.Sprintf("Poll interval: %ds", cfg.Server.PollInterval))
	logger.Info(fmt.Sprintf("Hooks port: %d", cfg.Hooks.Port))

	// Build agents and collect ui.AgentStatus handles.
	rawAgents := make([]*agent.Agent, 0, len(cfg.Agents))
	agentList := make([]hooks.Agent, 0, len(cfg.Agents))
	uiAgents := make([]ui.AgentStatus, 0, len(cfg.Agents))

	for _, ac := range cfg.Agents {
		p := provider.Detect(ac.Command, ac.Provider)
		logger.Info(fmt.Sprintf("  - %s  command=%s  dir=%s  provider=%s", ac.Name, ac.Command, ac.WorkDir, p.Name()))
		a := agent.New(ac)
		rawAgents = append(rawAgents, a)
		agentList = append(agentList, a)
		uiAgents = append(uiAgents, a)
	}

	// Start hook server (receives Stop / Notification events from CLI providers).
	hooks.StartHookServer(cfg, agentList)

	// Start each agent's poll loop in its own goroutine.
	for _, a := range agentList {
		go a.(*agent.Agent).Run(cfg)
	}

	logger.Info("Running — waiting for tasks...")

	// ui.Run blocks the main OS thread (required by macOS AppKit / systray).
	// Agents run in goroutines above; the hook server runs in its own goroutine.
	ui.Run(uiAgents, &agentController{agents: rawAgents}, cfg.Server.URL)
}

// agentController implements ui.PullController for all configured agents.
type agentController struct {
	agents []*agent.Agent
}

func (c *agentController) Pause() {
	for _, a := range c.agents {
		a.Pause()
	}
}

func (c *agentController) Resume() {
	for _, a := range c.agents {
		a.Resume()
	}
}

func (c *agentController) IsPaused() bool {
	if len(c.agents) == 0 {
		return false
	}
	return c.agents[0].IsPaused()
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
	fmt.Println("Get your agent token from https://tasksquad.ai")
	fmt.Println()

	token := read("Agent token (paste from portal)", "")
	name := read("Agent name", "my-agent")
	command := read("CLI command", "claude")
	providerName := provider.Detect(command, "").Name()
	workDir := read("Work directory", "~/Projects")

	cfg := fmt.Sprintf(`[[agents]]
token   = %q
name    = %q
command = %q
# provider = %q  # auto-detected from command; uncomment to override
work_dir = %q
`, token, name, command, providerName, workDir)

	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".tasksquad")
	os.MkdirAll(dir, 0755)
	path := filepath.Join(dir, "config.toml")

	if err := os.WriteFile(path, []byte(cfg), 0600); err != nil {
		fmt.Fprintf(os.Stderr, "error writing config: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("\nConfig written to %s\n", path)
	fmt.Printf("Detected provider: %s\n", providerName)
	fmt.Println("Run: tsq")
}

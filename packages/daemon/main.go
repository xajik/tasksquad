package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/tasksquad/daemon/agent"
	"github.com/tasksquad/daemon/analytics"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/autostart"
	"github.com/tasksquad/daemon/cmd"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/hooks"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/provider"
	"github.com/tasksquad/daemon/skills"
	"github.com/tasksquad/daemon/supervisor"
	"github.com/tasksquad/daemon/ui"
)

var version = "dev"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "init":
			cmd.RunInit()
			return
		case "login":
			cmd.RunLogin()
			return
		case "logout":
			cmd.RunLogout()
			return
		case "sessions":
			cmd.RunSessions()
			return
		case "attach":
			cmd.RunAttach(os.Args[2:])
			return
		case "logs":
			cmd.RunLogs(os.Args[2:])
			return
		case "pane":
			cmd.RunPane(os.Args[2:])
			return
		case "send":
			cmd.RunSend(os.Args[2:])
			return
		case "report":
			cmd.RunReport(os.Args[2:])
			return
		case "skill":
			cmd.RunSkill(os.Args[2:])
			return
		}
	}

	runDaemon()
}

func runDaemon() {
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

	analytics.Init(
		analytics.Config{
			APIKey:  cfg.Analytics.APIKey,
			Enabled: cfg.Analytics.Enabled,
		},
		config.DeviceID(),
		version,
	)
	analytics.Track("daemon_start", map[string]interface{}{
		"version": version,
	})

	if !auth.IsLoggedIn() {
		fmt.Println("Not logged in — starting login flow...")
		dashURL := dashboardURL(cfg.Server.URL)
		email, err := auth.Login(dashURL, cfg.Server.URL)
		if err != nil {
			fmt.Fprintf(os.Stderr, "login failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Logged in as %s\n\n", email)
		analytics.Track("user_login", map[string]interface{}{
			"email": email,
		})
		analytics.SetUserID(email)
	} else {
		analytics.SetUserID(auth.GetEmail())
	}

	logger.Info("TaskSquad daemon starting — tsq " + version)
	logger.Info(fmt.Sprintf("API: %s", cfg.Server.URL))
	logger.Info(fmt.Sprintf("Poll interval: %ds", cfg.Server.PollInterval))
	logger.Info(fmt.Sprintf("Hooks port: %d", cfg.Hooks.Port))
	logger.Info(fmt.Sprintf("User: %s", auth.GetEmail()))

	rawAgents := make([]*agent.Agent, 0, len(cfg.Agents))
	agentList := make([]hooks.Agent, 0, len(cfg.Agents))
	uiAgents := make([]ui.AgentStatus, 0, len(cfg.Agents))

	for _, ac := range cfg.Agents {
		p := provider.Detect(ac.Command, ac.Provider)
		logger.Info(fmt.Sprintf("  - %s  id=%s  command=%s  dir=%s  provider=%s", ac.Name, ac.ID, ac.Command, ac.WorkDir, p.Name()))
		a := agent.New(ac)
		rawAgents = append(rawAgents, a)
		agentList = append(agentList, a)
		uiAgents = append(uiAgents, a)
	}

	sup := supervisor.New(cfg)
	hooks.StartHookServer(cfg, agentList, sup)

	batchCtrl := agent.NewBatchController()
	go agent.RunBatch(cfg, rawAgents, batchCtrl)

	supAgents := make([]supervisor.MonitoredAgent, len(rawAgents))
	for i, a := range rawAgents {
		supAgents[i] = a
	}
	go sup.Monitor(supAgents)

	skillAgents := make([]skills.AgentRef, len(rawAgents))
	for i, a := range rawAgents {
		skillAgents[i] = a
	}
	skillsSyncer := skills.NewSyncer()
	go skills.StartSync(cfg, skillAgents, skillsSyncer)

	logger.Info("Running — waiting for tasks...")

	execPath, _ := os.Executable()
	markerPath := config.DefaultPath() + ".autostart-set"
	if _, err := os.Stat(markerPath); os.IsNotExist(err) {
		if err := autostart.Enable(execPath); err != nil {
			logger.Warn(fmt.Sprintf("[autostart] first-run enable failed: %v", err))
		} else {
			logger.Info("[autostart] Enabled run-on-boot (first run)")
			os.WriteFile(markerPath, []byte{}, 0600)
		}
	}

	authCtrl := &mainAuthController{}
	autostartCtrl := &mainAutostartController{execPath: execPath}
	ui.Run(uiAgents, &agentController{agents: rawAgents}, authCtrl, autostartCtrl, skillsSyncer, batchCtrl, dashboardURL(cfg.Server.URL), *cfgPath, version)
}

type mainAuthController struct{}

func (c *mainAuthController) Email() string { return auth.GetEmail() }
func (c *mainAuthController) Logout() error { return auth.Logout() }

type mainAutostartController struct{ execPath string }

func (c *mainAutostartController) IsEnabled() bool { return autostart.IsEnabled() }
func (c *mainAutostartController) Enable() error   { return autostart.Enable(c.execPath) }
func (c *mainAutostartController) Disable() error  { return autostart.Disable() }

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

func dashboardURL(cfgServerURL string) string {
	if u := os.Getenv("TSQ_DASHBOARD_URL"); u != "" {
		return u
	}
	dashURL := trimSuffix(cfgServerURL, "/api")
	if hasSuffix(cfgServerURL, ".api.tasksquad.ai") ||
		cfgServerURL == "https://api.tasksquad.ai" {
		return "https://tasksquad.ai"
	}
	return dashURL
}

func trimSuffix(s, suffix string) string {
	if len(s) >= len(suffix) && s[len(s)-len(suffix):] == suffix {
		return s[:len(s)-len(suffix)]
	}
	return s
}

func hasSuffix(s, suffix string) bool {
	return len(s) >= len(suffix) && s[len(s)-len(suffix):] == suffix
}

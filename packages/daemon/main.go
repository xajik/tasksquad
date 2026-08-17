package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/tasksquad/daemon/agent"
	"github.com/tasksquad/daemon/agents"
	"github.com/tasksquad/daemon/analytics"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/autostart"
	attachcmd "github.com/tasksquad/daemon/cmd/attach"
	authcmd "github.com/tasksquad/daemon/cmd/auth"
	hookscmd "github.com/tasksquad/daemon/cmd/hooks"
	kbcmd "github.com/tasksquad/daemon/cmd/kb"
	logscmd "github.com/tasksquad/daemon/cmd/logs"
	memorycmd "github.com/tasksquad/daemon/cmd/memory"
	screenshotcmd "github.com/tasksquad/daemon/cmd/screenshot"
	tagscmd "github.com/tasksquad/daemon/cmd/tags"
	tmuxcmd "github.com/tasksquad/daemon/cmd/tmux"
	"github.com/tasksquad/daemon/commands"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/dreamer"
	"github.com/tasksquad/daemon/hooks"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/orphan"
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
			authcmd.RunInit() //nolint:errcheck
			return
		case "login":
			authcmd.RunLogin() //nolint:errcheck
			return
		case "logout":
			authcmd.RunLogout() //nolint:errcheck
			return
		case "sessions":
			tmuxcmd.RunSessions()
			return
		case "attach":
			tmuxcmd.RunAttach(os.Args[2:])
			return
		case "logs":
			logscmd.RunLogs(os.Args[2:])
			return
		case "pane":
			tmuxcmd.RunPane(os.Args[2:])
			return
		case "screenshot":
			screenshotcmd.RunScreenshot(os.Args[2:])
			return
		case "send":
			tmuxcmd.RunSend(os.Args[2:])
			return
		case "report":
			hookscmd.RunReport(os.Args[2:]) //nolint:errcheck
			return
		case "send-image":
			attachcmd.RunAttach(os.Args[2:]) //nolint:errcheck
			return
		case "skill":
			hookscmd.RunSkill(os.Args[2:]) //nolint:errcheck
			return
		case "memory":
			memorycmd.RunMemory(os.Args[2:]) //nolint:errcheck
			return
		case "kb":
			kbcmd.RunKB(os.Args[2:]) //nolint:errcheck
			return
		case "tags":
			tagscmd.RunTags(os.Args[2:]) //nolint:errcheck
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

	ui.InitSpeechToMD(cfg)

	sup := supervisor.New(cfg)
	batchCtrl := agent.NewBatchController()
	hooks.StartHookServer(cfg, agentList, sup, ui.GetSpeechManager(), batchCtrl)

	go agent.RunBatch(cfg, rawAgents, batchCtrl)

	// Start orphan cleanup (runs on startup + hourly)
	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err == nil && token != "" {
		orphanCtrl := orphan.New(cfg, token)
		go orphanCtrl.Run()
	} else {
		logger.Warn("[orphan] skipped: no auth token")
	}

	supAgents := make([]supervisor.MonitoredAgent, len(rawAgents))
	for i, a := range rawAgents {
		supAgents[i] = a
	}
	go sup.Monitor(supAgents)

	dreamAgents := make([]dreamer.DreamAgent, len(rawAgents))
	for i, a := range rawAgents {
		dreamAgents[i] = a
	}
	if token != "" {
		d := dreamer.New(cfg)
		go d.Monitor(dreamAgents, token)
	} else {
		logger.Warn("[dreamer] skipped: no auth token")
	}

	skillAgents := make([]skills.AgentRef, len(rawAgents))
	for i, a := range rawAgents {
		skillAgents[i] = a
	}
	skillsSyncer := skills.NewSyncer()
	go skills.StartSync(cfg, skillAgents, skillsSyncer)

	agentRefs := make([]agents.AgentRef, len(rawAgents))
	for i, a := range rawAgents {
		agentRefs[i] = a
	}
	agentsSyncer := agents.NewSyncer()
	go agents.StartSync(cfg, agentRefs, agentsSyncer)

	commandRefs := make([]commands.AgentRef, len(rawAgents))
	for i, a := range rawAgents {
		commandRefs[i] = a
	}
	commandsSyncer := commands.NewSyncer()
	go commands.StartSync(cfg, commandRefs, commandsSyncer)

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
	logger.Info(fmt.Sprintf("UI port: %d", cfg.UI.Port))
	ui.Run(uiAgents, &agentController{agents: rawAgents}, authCtrl, autostartCtrl, skillsSyncer, batchCtrl, dashboardURL(cfg.Server.URL), *cfgPath, version, cfg.UI.Port)
}

func dashboardURL(cfgServerURL string) string {
	if u := os.Getenv("TSQ_DASHBOARD_URL"); u != "" {
		return u
	}
	if hasSuffix(cfgServerURL, ".api.tasksquad.ai") ||
		cfgServerURL == "https://api.tasksquad.ai" {
		return "https://tasksquad.ai"
	}
	return trimSuffix(cfgServerURL, "/api")
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

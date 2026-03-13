package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/tasksquad/daemon/agent"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/hooks"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/provider"
	"github.com/tasksquad/daemon/ui"
)

const version = "0.1.0"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "init":
			runInit()
			return
		case "login":
			runLogin()
			return
		case "logout":
			runLogout()
			return
		}
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

	if !auth.IsLoggedIn() {
		fmt.Println("Not logged in — starting login flow...")
		dashURL := dashboardURL(cfg.Server.URL)
		email, err := auth.Login(dashURL, cfg.Server.URL)
		if err != nil {
			fmt.Fprintf(os.Stderr, "login failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Logged in as %s\n\n", email)
	}

	logger.Info("TaskSquad daemon starting — tsq " + version)
	logger.Info(fmt.Sprintf("API: %s", cfg.Server.URL))
	logger.Info(fmt.Sprintf("Poll interval: %ds", cfg.Server.PollInterval))
	logger.Info(fmt.Sprintf("Hooks port: %d", cfg.Hooks.Port))
	logger.Info(fmt.Sprintf("User: %s", auth.GetEmail()))

	// Build agents and collect ui.AgentStatus handles.
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

	// Start hook server (receives Stop / Notification events from CLI providers).
	hooks.StartHookServer(cfg, agentList)

	// Run all agents in a single shared poll loop (one HTTP request per interval).
	go agent.RunBatch(cfg, rawAgents)

	logger.Info("Running — waiting for tasks...")

	// ui.Run blocks the main OS thread (required by macOS AppKit / systray).
	// Agents run in goroutines above; the hook server runs in its own goroutine.
	authCtrl := &mainAuthController{}
	ui.Run(uiAgents, &agentController{agents: rawAgents}, authCtrl, cfg.Server.URL, *cfgPath)
}

// mainAuthController implements ui.AuthController using the auth package.
type mainAuthController struct{}

func (c *mainAuthController) Email() string { return auth.GetEmail() }
func (c *mainAuthController) Logout() error { return auth.Logout() }

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

// dashboardURL returns the portal base URL to use for login.
// TSQ_DASHBOARD_URL env var overrides (useful for local dev via make dev + .env).
func dashboardURL(cfgServerURL string) string {
	if u := os.Getenv("TSQ_DASHBOARD_URL"); u != "" {
		return u
	}
	dashURL := strings.TrimSuffix(cfgServerURL, "/api")
	if strings.HasSuffix(cfgServerURL, ".api.tasksquad.ai") ||
		cfgServerURL == "https://api.tasksquad.ai" {
		return "https://tasksquad.ai"
	}
	return dashURL
}

// runLogin opens a browser for Firebase OAuth and stores credentials in the keychain.
func runLogin() {
	// Load config to get the dashboard URL and Firebase settings.
	cfg, err := config.Load(config.DefaultPath())
	if err != nil {
		// Use default dashboard URL if config not yet set up.
		cfg = &config.Config{}
		cfg.Server.URL = "https://tasksquad.ai"
	}

	dashURL := dashboardURL(cfg.Server.URL)

	email, err := auth.Login(dashURL, cfg.Server.URL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "login failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Logged in as %s\n", email)
}

// runLogout removes stored credentials from the keychain.
func runLogout() {
	if err := auth.Logout(); err != nil {
		fmt.Fprintf(os.Stderr, "logout error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Logged out.")
}

// runInit is a guided wizard that:
//  1. Runs Firebase OAuth to authenticate the user.
//  2. Fetches the user's agents from the server.
//  3. Writes ~/.tasksquad/config.toml with the matched agents.
func runInit() {
	scanner := strings.NewReader("") // placeholder — we use fmt.Scan below
	_ = scanner

	fmt.Println("TaskSquad daemon setup")
	fmt.Println("----------------------")
	fmt.Println()

	// Step 1: Firebase login.
	fmt.Println("Step 1: Log in to TaskSquad")
	cfg := &config.Config{}
	cfg.Server.URL = "https://api.tasksquad.ai"

	dashURL := dashboardURL(cfg.Server.URL)

	email, err := auth.Login(dashURL, cfg.Server.URL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "login failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Logged in as %s\n\n", email)

	// Step 2: Fetch user's agents from server.
	fmt.Println("Step 2: Fetching your agents from the server...")
	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "auth error: %v\n", err)
		os.Exit(1)
	}

	agentsData, err := fetchUserAgents(cfg.Server.URL, token)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to fetch agents: %v\n", err)
		os.Exit(1)
	}

	if len(agentsData) == 0 {
		fmt.Println("No agents found. Create agents in the TaskSquad portal first.")
		fmt.Printf("  %s/dashboard\n", dashURL)
		os.Exit(1)
	}

	fmt.Printf("Found %d agent(s):\n", len(agentsData))
	for _, a := range agentsData {
		fmt.Printf("  - %s (id: %s)\n", a.Name, a.ID)
	}
	fmt.Println()

	// Step 3: Prompt for CLI command and work directory per agent.
	readLine := func(prompt, def string) string {
		if def != "" {
			fmt.Printf("%s [%s]: ", prompt, def)
		} else {
			fmt.Printf("%s: ", prompt)
		}
		var v string
		fmt.Scanln(&v)
		v = strings.TrimSpace(v)
		if v == "" {
			return def
		}
		return v
	}

	var agentBlocks []string
	for _, a := range agentsData {
		fmt.Printf("Configure agent: %s\n", a.Name)
		command := readLine("  CLI command", "claude")
		workDir := readLine("  Work directory", "~/Projects")
		providerName := provider.Detect(command, "").Name()

		block := fmt.Sprintf(`[[agents]]
id       = %q
name     = %q
command  = %q
# provider = %q  # auto-detected from command; uncomment to override
work_dir = %q
`, a.ID, a.Name, command, providerName, workDir)
		agentBlocks = append(agentBlocks, block)
		fmt.Println()
	}

	// Step 4: Write config.
	cfgContent := strings.Join(agentBlocks, "\n")

	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".tasksquad")
	os.MkdirAll(dir, 0755)
	path := filepath.Join(dir, "config.toml")

	if err := os.WriteFile(path, []byte(cfgContent), 0600); err != nil {
		fmt.Fprintf(os.Stderr, "error writing config: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Config written to %s\n", path)
	fmt.Println("Run: tsq")
}

// serverAgent is the API response shape from GET /daemon/user/agents.
type serverAgent struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// fetchUserAgents calls GET /daemon/user/agents and returns the list of agents.
func fetchUserAgents(apiURL, token string) ([]serverAgent, error) {
	req, err := http.NewRequest("GET", apiURL+"/daemon/user/agents", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
	}

	var body struct {
		Agents []serverAgent `json:"agents"`
	}
	if err := json.Unmarshal(b, &body); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}
	return body.Agents, nil
}

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/tasksquad/daemon/agent"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/autostart"
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
		case "sessions":
			runSessions()
			return
		case "attach":
			runAttach(os.Args[2:])
			return
		case "logs":
			runLogs(os.Args[2:])
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

	// Enable autostart on first run (marker file prevents re-enabling after user disables it).
	execPath, _ := os.Executable()
	markerPath := filepath.Join(filepath.Dir(config.DefaultPath()), ".autostart-set")
	if _, err := os.Stat(markerPath); os.IsNotExist(err) {
		if err := autostart.Enable(execPath); err != nil {
			logger.Warn(fmt.Sprintf("[autostart] first-run enable failed: %v", err))
		} else {
			logger.Info("[autostart] Enabled run-on-boot (first run)")
			os.WriteFile(markerPath, []byte{}, 0600) //nolint:errcheck
		}
	}

	// ui.Run blocks the main OS thread (required by macOS AppKit / systray).
	// Agents run in goroutines above; the hook server runs in its own goroutine.
	authCtrl := &mainAuthController{}
	autostartCtrl := &mainAutostartController{execPath: execPath}
	ui.Run(uiAgents, &agentController{agents: rawAgents}, authCtrl, autostartCtrl, cfg.Server.URL, *cfgPath)
}

// mainAuthController implements ui.AuthController using the auth package.
type mainAuthController struct{}

func (c *mainAuthController) Email() string { return auth.GetEmail() }
func (c *mainAuthController) Logout() error { return auth.Logout() }

// mainAutostartController implements ui.AutostartController using the autostart package.
type mainAutostartController struct{ execPath string }

func (c *mainAutostartController) IsEnabled() bool  { return autostart.IsEnabled() }
func (c *mainAutostartController) Enable() error    { return autostart.Enable(c.execPath) }
func (c *mainAutostartController) Disable() error   { return autostart.Disable() }

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

// tmuxSessionPrefix is the prefix used for all tsq-managed tmux sessions.
const tmuxSessionPrefix = "tsq-"

// sessionNameFromArg converts a user-supplied argument to a tsq session name.
// Accepts either a full session name (tsq-XXXXXXXX), a raw task ID, or the
// first 8 characters of a task ID.
func sessionNameFromArg(arg string) string {
	if strings.HasPrefix(arg, tmuxSessionPrefix) {
		return arg
	}
	suffix := arg
	if len(suffix) > 8 {
		suffix = suffix[:8]
	}
	return tmuxSessionPrefix + suffix
}

// runSessions lists all active tsq tmux sessions (prefix tsq-).
func runSessions() {
	out, err := exec.Command("tmux", "list-sessions", "-F",
		"#{session_name}\t#{session_windows} window(s)\tcreated #{t:session_created}").Output()
	if err != nil {
		// tmux exits non-zero when there are no sessions at all.
		fmt.Println("No active tsq sessions.")
		return
	}

	var found bool
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.HasPrefix(line, tmuxSessionPrefix) {
			if !found {
				fmt.Println("Active tsq sessions:")
				found = true
			}
			fmt.Println(" ", line)
		}
	}
	if !found {
		fmt.Println("No active tsq sessions.")
	}
}

// runAttach attaches the terminal to a tsq tmux session.
//
// Usage:
//
//	tsq attach                   — attach to the only active tsq session (or list if multiple)
//	tsq attach <taskID>          — attach to session tsq-<taskID[:8]>
//	tsq attach <tsq-XXXXXXXX>   — attach by full session name
func runAttach(args []string) {
	var sessionName string

	if len(args) == 0 {
		// No argument: find the single active tsq session automatically.
		out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").Output()
		if err != nil {
			fmt.Println("No active tsq sessions.")
			return
		}
		var sessions []string
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if strings.HasPrefix(line, tmuxSessionPrefix) {
				sessions = append(sessions, line)
			}
		}
		switch len(sessions) {
		case 0:
			fmt.Println("No active tsq sessions.")
			return
		case 1:
			sessionName = sessions[0]
		default:
			fmt.Println("Multiple active tsq sessions — specify one:")
			for _, s := range sessions {
				fmt.Println(" ", s)
			}
			fmt.Println("\nUsage: tsq attach <taskID>")
			return
		}
	} else {
		sessionName = sessionNameFromArg(args[0])
	}

	fmt.Printf("Attaching to %s (detach: Ctrl-b d)\n", sessionName)
	cmd := exec.Command("tmux", "attach-session", "-t", sessionName)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "error: session %q not found or tmux unavailable\n", sessionName)
		os.Exit(1)
	}
}

// runLogs shows a local task run log or the daemon log.
//
// Usage:
//
//	tsq logs                            — tail today's daemon log
//	tsq logs <agentName>                — list task logs for an agent
//	tsq logs <agentName> <taskID>       — tail a specific task log
func runLogs(args []string) {
	home, _ := os.UserHomeDir()
	logsDir := filepath.Join(home, ".tasksquad", "logs")

	switch len(args) {
	case 0:
		// Tail today's daemon log.
		today := fmt.Sprintf("daemon-%s.log", nowDate())
		path := filepath.Join(logsDir, today)
		tailFile(path)

	case 1:
		agentName := args[0]
		agentLogsDir := filepath.Join(logsDir, sanitizeAgentName(agentName))
		entries, err := os.ReadDir(agentLogsDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "no logs found for agent %q (looked in %s)\n", agentName, agentLogsDir)
			os.Exit(1)
		}
		fmt.Printf("Task logs for agent %q:\n", agentName)
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".log") {
				info, _ := e.Info()
				taskID := strings.TrimSuffix(e.Name(), ".log")
				fmt.Printf("  %s  (%s)\n", taskID, info.ModTime().Format("2006-01-02 15:04:05"))
			}
		}

	default:
		agentName, taskID := args[0], args[1]
		path := filepath.Join(logsDir, sanitizeAgentName(agentName), taskID+".log")
		tailFile(path)
	}
}

// tailFile prints the contents of path to stdout (like cat).
func tailFile(path string) {
	f, err := os.Open(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "log not found: %s\n", path)
		os.Exit(1)
	}
	defer f.Close()
	fmt.Printf("=== %s ===\n", path)
	io.Copy(os.Stdout, f) //nolint:errcheck
}

// nowDate returns today's date as YYYY-MM-DD.
func nowDate() string {
	out, err := exec.Command("date", "+%Y-%m-%d").Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}

// sanitizeAgentName mirrors logger.sanitizeName: replaces non-alphanumeric chars with '-'.
func sanitizeAgentName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	return b.String()
}

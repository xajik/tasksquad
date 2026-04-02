package authcmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/tasksquad/daemon/analytics"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/provider"
)

func RunLogin() error {
	cfg, err := config.Load(config.DefaultPath())
	if err != nil {
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
	return nil
}

func RunLogout() error {
	if err := auth.Logout(); err != nil {
		fmt.Fprintf(os.Stderr, "logout error: %v\n", err)
		os.Exit(1)
	}
	analytics.Track("user_logout", nil)
	fmt.Println("Logged out.")
	return nil
}

func RunInit() error {
	fmt.Println("TaskSquad daemon setup")
	fmt.Println("----------------------")
	fmt.Println()

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
		p := provider.Detect(command, "")

		block := fmt.Sprintf(`[[agents]]
id       = %q
name     = %q
command  = %q
# provider = %q
work_dir = %q
`, a.ID, a.Name, command, p.Name(), workDir)
		agentBlocks = append(agentBlocks, block)
		fmt.Println()
	}

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
	return nil
}

type serverAgent struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

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

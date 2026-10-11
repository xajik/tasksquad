// Package customer implements user-authenticated cloud orchestration. It never
// starts a daemon or infers a mutation's project from the current directory.
package customer

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/tasksquad/daemon/agents"
	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/commands"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/provider"
	"github.com/tasksquad/daemon/skills"
)

type stringsFlag []string

func (s *stringsFlag) String() string     { return strings.Join(*s, ",") }
func (s *stringsFlag) Set(v string) error { *s = append(*s, v); return nil }

var identifier = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type Options struct {
	Group, Action, Project, ID, Agent, Subject, Body, File, Status, Name, Config, APIURL string
	JSON                                                                                 bool
	Timeout                                                                              time.Duration
	Images                                                                               stringsFlag
}

func Parse(args []string) (Options, error) {
	o := Options{}
	if len(args) == 0 {
		return o, fmt.Errorf("expected projects, agents, tasks, portals, resources, or doctor")
	}
	o.Group = args[0]
	args = args[1:]
	if o.Group != "doctor" {
		if len(args) == 0 {
			return o, fmt.Errorf("subcommand required")
		}
		o.Action = args[0]
		args = args[1:]
	}
	fs := flag.NewFlagSet("tsq "+o.Group+" "+o.Action, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&o.Project, "project", "", "explicit project ID")
	fs.StringVar(&o.ID, "id", "", "task or Portal ID")
	fs.StringVar(&o.Agent, "agent", "", "agent ID")
	fs.StringVar(&o.Name, "name", "", "agent name")
	fs.StringVar(&o.Subject, "subject", "", "task subject")
	fs.StringVar(&o.Body, "body", "", "message body")
	fs.StringVar(&o.File, "file", "", "UTF-8 body file, or - for stdin")
	fs.StringVar(&o.Status, "status", "waiting_input", "wait target status")
	fs.StringVar(&o.Config, "config", config.DefaultPath(), "config path")
	fs.StringVar(&o.APIURL, "api-url", "", "override API URL")
	fs.BoolVar(&o.JSON, "json", false, "machine-readable output")
	fs.DurationVar(&o.Timeout, "timeout", 5*time.Minute, "overall deadline, at most 30m")
	fs.Var(&o.Images, "image", "image attachment (repeatable)")
	if err := fs.Parse(args); err != nil {
		return o, err
	}
	if fs.NArg() != 0 {
		return o, fmt.Errorf("unexpected arguments; use --id for a task or Portal")
	}
	valid := map[string]string{"projects": "list", "agents": "list create", "tasks": "create get list reply close wait", "portals": "create get list close", "resources": "audit sync", "doctor": ""}
	actions, ok := valid[o.Group]
	if !ok || (o.Group != "doctor" && !strings.Contains(" "+actions+" ", " "+o.Action+" ")) {
		return o, fmt.Errorf("unsupported command")
	}
	if o.Group != "projects" && o.Group != "doctor" && o.Project == "" {
		return o, fmt.Errorf("--project is required")
	}
	for _, id := range []string{o.Project, o.ID, o.Agent} {
		if id != "" && !identifier.MatchString(id) {
			return o, fmt.Errorf("invalid ID")
		}
	}
	if o.Action == "get" || o.Action == "reply" || o.Action == "close" || o.Action == "wait" {
		if o.ID == "" {
			return o, fmt.Errorf("--id is required")
		}
	}
	if o.Action == "create" && (o.Group == "tasks" || o.Group == "portals") && o.Agent == "" {
		return o, fmt.Errorf("--agent is required")
	}
	if o.Group == "tasks" && o.Action == "create" && strings.TrimSpace(o.Subject) == "" {
		return o, fmt.Errorf("--subject is required")
	}
	if o.Group == "agents" && o.Action == "create" && strings.TrimSpace(o.Name) == "" {
		return o, fmt.Errorf("--name is required")
	}
	if o.Body != "" && o.File != "" {
		return o, fmt.Errorf("use either --body or --file")
	}
	if o.Timeout <= 0 || o.Timeout > 30*time.Minute {
		return o, fmt.Errorf("--timeout must be between 0 and 30m")
	}
	return o, nil
}

func Run(args []string, version string, out, stderr io.Writer) int {
	o, err := Parse(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if o.File != "" {
		var reader io.Reader = os.Stdin
		if o.File != "-" {
			f, e := os.Open(o.File)
			if e != nil {
				fmt.Fprintln(stderr, "cannot read body file")
				return 2
			}
			defer f.Close()
			reader = f
		}
		data, e := io.ReadAll(io.LimitReader(reader, 1024*1024+1))
		if e != nil || len(data) > 1024*1024 {
			fmt.Fprintln(stderr, "body exceeds 1 MiB or cannot be read")
			return 2
		}
		o.Body = string(data)
	}
	if o.Action == "reply" && strings.TrimSpace(o.Body) == "" {
		fmt.Fprintln(stderr, "reply body is required")
		return 2
	}
	cfg, err := config.LoadCustomer(o.Config)
	if err != nil {
		fmt.Fprintln(stderr, "Cannot load configuration; run tsq init or supply --config.")
		return 1
	}
	if o.APIURL != "" {
		cfg.Server.URL = o.APIURL
	}
	if o.Group == "doctor" {
		_, statErr := os.Stat(o.Config)
		checks := map[string]any{"version": version, "config_valid": statErr == nil, "authenticated": auth.IsLoggedIn()}
		for _, name := range []string{"tmux", "claude", "codex"} {
			path, _ := exec.LookPath(name)
			checks[name] = path
		}
		emit(out, checks, o.JSON)
		return 0
	}
	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		fmt.Fprintln(stderr, "Authentication failed; run tsq login.")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), o.Timeout)
	defer cancel()
	client := api.CustomerClient{BaseURL: cfg.Server.URL, Token: token, HTTP: &http.Client{Timeout: 60 * time.Second}}
	var result map[string]any
	if o.Group == "resources" {
		if len(cfg.Agents) == 0 { fmt.Fprintln(stderr,"Resources sync needs configured local agents; run tsq init first."); return 1 }
		result, err = resources(ctx, client, cfg, o)
	} else {
		result, err = Execute(ctx, client, o)
	}
	if err != nil {
		if result != nil {
			emit(out, result, o.JSON)
		}
		fmt.Fprintln(stderr, err)
		if errors.Is(err, context.DeadlineExceeded) {
			return 3
		}
		return 1
	}
	emit(out, result, o.JSON)
	return 0
}

func Execute(ctx context.Context, c api.CustomerClient, o Options) (map[string]any, error) {
	request := func(method, path string, body map[string]any) (map[string]any, error) {
		return c.Request(ctx, method, path, body, nil)
	}
	if o.Group == "projects" {
		return request("GET", "/teams", nil)
	}
	if o.Group == "agents" {
		path := "/teams/" + o.Project + "/agents"
		if o.Action == "create" {
			return request("POST", path, map[string]any{"name": o.Name})
		}
		return request("GET", path, nil)
	}
	base := "/" + o.Group
	if o.Action == "list" {
		return request("GET", base+"?team_id="+url.QueryEscape(o.Project), nil)
	}
	if o.Action == "create" {
		body := map[string]any{"team_id": o.Project, "agent_id": o.Agent}
		if o.Group == "tasks" {
			body["subject"] = o.Subject
			body["body"] = o.Body
		}
		return c.Request(ctx, "POST", base, body, o.Images)
	}
	path := base + "/" + o.ID
	for {
		record, err := request("GET", path, nil)
		if err != nil {
			return nil, err
		}
		if record["team_id"] != o.Project {
			return nil, fmt.Errorf("record does not belong to --project")
		}
		switch o.Action {
		case "close":
			return request("POST", path+"/close", map[string]any{})
		case "reply":
			return c.Request(ctx, "POST", path+"/messages", map[string]any{"body": o.Body}, o.Images)
		case "get":
			if o.Group == "tasks" {
				messages, err := request("GET", path+"/messages", nil)
				if err != nil {
					return nil, err
				}
				record["messages"] = messages["messages"]
			}
			return record, nil
		case "wait":
			if record["status"] == o.Status {
				return record, nil
			}
			if record["status"] == "done" || record["status"] == "failed" || record["status"] == "cancelled" {
				return record, fmt.Errorf("task reached %v before %s", record["status"], o.Status)
			}
			select {
			case <-ctx.Done():
				return record, ctx.Err()
			case <-time.After(time.Second):
			}
		default:
			return nil, fmt.Errorf("unsupported action")
		}
	}
}

type configuredAgent struct{ id, workDir, providerName string }

func (a configuredAgent) AgentID() string { return a.id }
func (a configuredAgent) WorkDir() string { return a.workDir }

func resources(ctx context.Context, c api.CustomerClient, cfg *config.Config, o Options) (map[string]any, error) {
	project, err := c.Request(ctx, "GET", "/teams/"+o.Project+"/agents", nil, nil)
	if err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	projectAgents, _ := project["agents"].([]any)
	for _, raw := range projectAgents {
		item, _ := raw.(map[string]any)
		id, _ := item["id"].(string)
		if id != "" {
			ids[id] = true
		}
	}
	var targets []configuredAgent
	for _, agent := range cfg.Agents {
		if ids[agent.ID] {
			targets = append(targets, configuredAgent{agent.ID, agent.WorkDir, provider.Detect(agent.Command, agent.Provider).Name()})
		}
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("no configured daemon agents belong to --project")
	}
	if o.Action == "sync" {
		skillTargets := make([]skills.AgentRef, len(targets))
		agentTargets := make([]agents.AgentRef, len(targets))
		commandTargets := make([]commands.AgentRef, len(targets))
		for i, target := range targets {
			skillTargets[i] = target
			agentTargets[i] = target
			commandTargets[i] = target
		}
		skills.SyncNow(cfg, skillTargets)
		agents.SyncNow(cfg, agentTargets)
		commands.SyncNow(cfg, commandTargets)
	}
	kinds := map[string]string{"skills": "skills", "sub-agents": "sub-agents", "commands": "commands"}
	var missing []string
	for _, agent := range targets {
		for _, path := range []struct{ endpoint, envelope string }{{"/daemon/user/skills", "skills"}, {"/daemon/user/sub-agents", "sub_agents"}, {"/daemon/user/commands", "commands"}} {
			response, e := c.Request(ctx, "GET", path.endpoint+"?agent_id="+url.QueryEscape(agent.id), nil, nil)
			if e != nil {
				return nil, e
			}
			items, _ := response[path.envelope].([]any)
			for _, raw := range items {
				item, _ := raw.(map[string]any)
				name, _ := item["name"].(string)
				if name == "" {
					continue
				}
				install, _ := item["auto_install"].(float64)
				def, _ := item["is_default"].(float64)
				if install == 0 && def == 0 {
					continue
				}
				if team, _ := item["team_id"].(string); team != "" && team != o.Project {
					continue
				}
				filename := name + ".md"
				if path.envelope == "skills" {
					filename = "SKILL.md"
				}
				folder := kinds[path.envelope]
				if path.envelope == "sub_agents" {
					folder = "agents"
				}
				canonical := filepath.Join(agent.workDir, ".tsq", folder, name, filename)
				if path.envelope != "skills" {
					canonical = filepath.Join(agent.workDir, ".tsq", folder, filename)
				}
				if _, e := os.Stat(canonical); e != nil {
					missing = append(missing, agent.id+":"+path.envelope+":"+name)
					continue
				}
				// Check the representation installed for the configured provider.
				base := providerBase(agent.providerName)
				if base != "" {
					rel := filepath.Join(base, folder, name+".md")
					if path.envelope == "skills" {
						rel = filepath.Join(base, "skills", name, "SKILL.md")
					}
					if _, e := os.Stat(filepath.Join(agent.workDir, rel)); e != nil {
						missing = append(missing, agent.id+":provider:"+name)
					}
				}
			}
		}
	}
	return map[string]any{"project_id": o.Project, "agents": len(targets), "missing": missing, "healthy": len(missing) == 0, "synced": o.Action == "sync"}, nil
}

func providerBase(name string) string {
	switch name {
	case "claude-code":
		return ".claude"
	case "codex", "opencode":
		return ".agents"
	case "gemini":
		return ".gemini"
	case "pi":
		return ".pi"
	case "claw":
		return ".agent"
	default:
		return ""
	}
}

func emit(out io.Writer, value map[string]any, machine bool) {
	// Responses may grow credential fields later; redact recursively at the boundary.
	var redact func(any) any
	redact = func(v any) any {
		switch x := v.(type) {
		case map[string]any:
			for key, val := range x {
				k := strings.ToLower(key)
				if strings.Contains(k, "token") || strings.Contains(k, "secret") || strings.Contains(k, "password") || strings.Contains(k, "credential") {
					x[key] = "[redacted]"
				} else {
					x[key] = redact(val)
				}
			}
		case []any:
			for i := range x {
				x[i] = redact(x[i])
			}
		}
		return v
	}
	encoder := json.NewEncoder(out)
	if !machine {
		encoder.SetIndent("", "  ")
	}
	_ = encoder.Encode(redact(value))
}

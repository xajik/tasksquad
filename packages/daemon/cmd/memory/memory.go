// Package memorycmd implements `tsq memory push` and `tsq memory search`.
//
// Unlike `tsq skill` (packages/daemon/cmd/hooks/hooks.go), which forwards to
// the running daemon's local hooks server and relies on it to know which
// agent is "currently learning", these subcommands talk to the worker
// directly (github.com/tasksquad/daemon/api), the same way
// packages/daemon/skills/sync.go does. That's required because
// `tsq memory push --scope global` and `tsq memory search` need to work from
// a bare terminal, not just from inside an active close-session skill run —
// there is no local hooks server to forward to in that case.
package memorycmd

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/tasksquad/daemon/agentctx"
	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/memory"
)

var validCategories = map[string]bool{
	memory.CategoryPersonal:     true,
	memory.CategoryPreferences:  true,
	memory.CategoryStructure:    true,
	memory.CategoryArchitecture: true,
	memory.CategoryEvents:       true,
}

// RunMemory dispatches `tsq memory <push|search> ...`.
func RunMemory(args []string) error {
	if len(args) == 0 {
		usageMemory()
		os.Exit(1)
	}

	switch args[0] {
	case "push":
		return runPush(args[1:])
	case "search":
		return runSearch(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "unknown memory subcommand %q — expected push or search\n", args[0])
		os.Exit(1)
	}
	return nil
}

func usageMemory() {
	fmt.Fprintln(os.Stderr, "usage: tsq memory push --scope local|global --category <c> --title <t> [--tags a,b] --file <path>")
	fmt.Fprintln(os.Stderr, "       tsq memory search <query>")
}

// ── push ────────────────────────────────────────────────────────────────────

func runPush(args []string) error {
	fs := flag.NewFlagSet("memory push", flag.ContinueOnError)
	scope := fs.String("scope", "", "local | global (required)")
	category := fs.String("category", "", "personal | preferences | structure | architecture | events (required)")
	title := fs.String("title", "", "short title (required)")
	tagsFlag := fs.String("tags", "", "comma-separated tags")
	file := fs.String("file", "", "path to markdown content (reads stdin if omitted)")

	if err := fs.Parse(args); err != nil {
		os.Exit(1)
	}

	if *scope != "local" && *scope != "global" {
		fmt.Fprintln(os.Stderr, "error: --scope must be \"local\" or \"global\"")
		usageMemory()
		os.Exit(1)
	}
	if !validCategories[*category] {
		fmt.Fprintln(os.Stderr, "error: --category must be one of personal, preferences, structure, architecture, events")
		usageMemory()
		os.Exit(1)
	}
	if *title == "" {
		fmt.Fprintln(os.Stderr, "error: --title is required")
		usageMemory()
		os.Exit(1)
	}

	content, err := readContent(*file)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error reading content: %v\n", err)
		os.Exit(1)
	}

	tags := memory.SplitTags(*tagsFlag)

	if *scope == "local" {
		pushLocal(*category, *title, content, tags)
	} else {
		pushGlobal(*category, *title, content, tags)
	}
	return nil
}

func pushLocal(category, title, content string, tags []string) {
	workDir, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error resolving work dir: %v\n", err)
		os.Exit(1)
	}

	path, err := memory.WriteLocal(workDir, category, title, content, tags)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error writing local memory: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Saved local memory entry: %s\n", path)
}

func pushGlobal(category, title, content string, tags []string) {
	cfg, err := config.Load(config.DefaultPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "error loading config: %v\n", err)
		os.Exit(1)
	}
	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "auth error: %v\n", err)
		os.Exit(1)
	}

	workDir, _ := os.Getwd()
	agentID := agentctx.CurrentAgentID(cfg, workDir)
	if agentID == "" {
		fmt.Fprintf(os.Stderr, "warning: could not resolve the current agent from work_dir %q — the server will reject this push\n", workDir)
	}

	resp, err := api.Post(cfg, token, agentID, "/daemon/memory", map[string]any{
		"category": category,
		"title":    title,
		"content":  content,
		"tags":     tags,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "error pushing memory: %v\n", err)
		os.Exit(1)
	}

	// /daemon/memory returns 201 on success, but we print "HTTP 200" for
	// consistency with tsq skill's established UX (its local hooks-server
	// proxy always reports 200 regardless of the worker's real status) — the
	// SKILL doc tells agents to look for a 2xx-shaped line here, not to
	// depend on the exact code.
	body, _ := json.Marshal(resp)
	fmt.Printf("HTTP 200: %s\n", body)
}

// ── search ──────────────────────────────────────────────────────────────────

func runSearch(args []string) error {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: tsq memory search <query>")
		os.Exit(1)
	}
	query := strings.Join(args, " ")

	workDir, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error resolving work dir: %v\n", err)
		os.Exit(1)
	}

	// Local memory always works, even offline — it's a pure filesystem read.
	local, localErr := memory.SearchLocal(workDir, query)
	if localErr != nil {
		fmt.Fprintf(os.Stderr, "local search error: %v\n", localErr)
	}

	global, globalErr := searchGlobal(query, workDir)

	for _, e := range local {
		printEntry(e)
	}
	for _, e := range global {
		printEntry(e)
	}
	if len(local) == 0 && len(global) == 0 && globalErr == nil {
		fmt.Println("No memory entries found.")
	}
	if globalErr != nil {
		fmt.Fprintf(os.Stderr, "global search unavailable (showing local results only): %v\n", globalErr)
	}
	return nil
}

func searchGlobal(query, workDir string) ([]memory.Entry, error) {
	cfg, err := config.Load(config.DefaultPath())
	if err != nil {
		return nil, err
	}
	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		return nil, err
	}
	agentID := agentctx.CurrentAgentID(cfg, workDir)
	if agentID == "" {
		return nil, fmt.Errorf("current directory doesn't match any configured agent's work_dir")
	}

	path := "/daemon/memory/search?q=" + url.QueryEscape(query)
	resp, err := api.GetWithAgent(cfg, token, agentID, path)
	if err != nil {
		return nil, err
	}

	raw, _ := resp["memory"].([]any)
	entries := make([]memory.Entry, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			entries = append(entries, globalEntryFromMap(m))
		}
	}
	return entries, nil
}

// globalEntryFromMap converts one row of /daemon/memory/search's response
// (id, team_id, agent_id, category, title, content, created_at, updated_at —
// no tags, unlike the portal-facing list/get endpoints) into an Entry.
func globalEntryFromMap(m map[string]any) memory.Entry {
	title, _ := m["title"].(string)
	category, _ := m["category"].(string)
	content, _ := m["content"].(string)
	return memory.Entry{
		Scope:    "global",
		Category: category,
		Title:    title,
		Excerpt:  truncate(strings.TrimSpace(content), 160),
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func printEntry(e memory.Entry) {
	tags := ""
	if len(e.Tags) > 0 {
		tags = " [" + strings.Join(e.Tags, ", ") + "]"
	}
	fmt.Printf("[%s] (%s) %s%s\n    %s\n", e.Scope, e.Category, e.Title, tags, e.Excerpt)
}

// readContent reads from --file if given, otherwise from stdin — mirrors
// tsq skill's --file/stdin convention (packages/daemon/cmd/hooks/hooks.go).
func readContent(file string) (string, error) {
	if file != "" {
		b, err := os.ReadFile(file)
		return string(b), err
	}
	b, err := io.ReadAll(os.Stdin)
	return string(b), err
}

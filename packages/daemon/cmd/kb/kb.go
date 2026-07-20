// Package kbcmd implements `tsq kb search` and `tsq kb init`.
//
// search is a pure local filesystem read (packages/daemon/kb), same as
// memorycmd's local search half — tsq/kb isn't mirrored server-side as
// searchable content, so there is no worker round-trip. init is a standalone
// bootstrap that resolves config and CWD itself and spawns its own tmux
// print-mode session via packages/daemon/dreamer.RunInit; it does not
// require the background daemon to be running, the same class as `tsq init`
// and `tsq login`.
package kbcmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/tasksquad/daemon/agentctx"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/dreamer"
	"github.com/tasksquad/daemon/kb"
)

// RunKB dispatches `tsq kb <search|init> ...`.
func RunKB(args []string) error {
	if len(args) == 0 {
		usageKB()
		os.Exit(1)
	}

	switch args[0] {
	case "search":
		return runSearch(args[1:])
	case "init":
		return runInit()
	default:
		fmt.Fprintf(os.Stderr, "unknown kb subcommand %q — expected search or init\n", args[0])
		os.Exit(1)
	}
	return nil
}

func usageKB() {
	fmt.Fprintln(os.Stderr, "usage: tsq kb search <query>")
	fmt.Fprintln(os.Stderr, "       tsq kb init")
}

// ── search ──────────────────────────────────────────────────────────────────

func runSearch(args []string) error {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: tsq kb search <query>")
		os.Exit(1)
	}
	query := strings.Join(args, " ")

	workDir, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error resolving work dir: %v\n", err)
		os.Exit(1)
	}

	entries, err := kb.Search(workDir, query)
	if err != nil {
		fmt.Fprintf(os.Stderr, "kb search error: %v\n", err)
		os.Exit(1)
	}

	if len(entries) == 0 {
		fmt.Println("No knowledge base entries found.")
		return nil
	}
	for _, e := range entries {
		printEntry(e)
	}
	return nil
}

func printEntry(e kb.Entry) {
	tags := ""
	if len(e.Tags) > 0 {
		tags = " [" + strings.Join(e.Tags, ", ") + "]"
	}
	fmt.Printf("%s%s\n    %s\n    %s\n", e.Title, tags, e.Path, e.Excerpt)
}

// ── init ────────────────────────────────────────────────────────────────────

func runInit() error {
	workDir, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error resolving work dir: %v\n", err)
		os.Exit(1)
	}

	cfg, err := config.Load(config.DefaultPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "error loading config: %v\n", err)
		os.Exit(1)
	}

	agentID := agentctx.CurrentAgentID(cfg, workDir)
	if agentID == "" {
		fmt.Fprintf(os.Stderr, "warning: could not resolve the current agent from work_dir %q — continuing without one\n", workDir)
	}

	if err := dreamer.RunInit(cfg, workDir, agentID); err != nil {
		fmt.Fprintf(os.Stderr, "error starting kb init: %v\n", err)
		os.Exit(1)
	}
	return nil
}

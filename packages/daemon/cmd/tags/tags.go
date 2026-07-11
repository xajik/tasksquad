// Package tagscmd implements `tsq tags pull` — lists the team's shared tag
// universe (used by both notes and memory in the portal; see
// packages/worker/src/routes/tags.ts).
//
// GET /teams/:teamId/tags is firebaseRoute-wrapped, not daemonRoute — it's a
// portal-facing endpoint reused here, so it needs a real :teamId path
// segment rather than the X-TSQ-Agent header daemonRoute endpoints use. The
// daemon has no local notion of "team" (config.toml only lists agent IDs and
// work dirs), so we resolve it via agentctx.CurrentTeamID, which piggybacks
// on the existing GET /daemon/user/agents endpoint (already returns each
// agent's team_id — see cmd/auth's tsq init flow for the other consumer).
package tagscmd

import (
	"fmt"
	"os"

	"github.com/tasksquad/daemon/agentctx"
	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
)

// RunTags dispatches `tsq tags <pull>`.
func RunTags(args []string) error {
	if len(args) == 0 || args[0] != "pull" {
		fmt.Fprintln(os.Stderr, "usage: tsq tags pull")
		os.Exit(1)
	}
	return runPull()
}

func runPull() error {
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
	teamID, err := agentctx.CurrentTeamID(cfg, token, workDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error resolving team: %v\n", err)
		os.Exit(1)
	}

	resp, err := api.Get(cfg, token, "/teams/"+teamID+"/tags")
	if err != nil {
		fmt.Fprintf(os.Stderr, "error fetching tags: %v\n", err)
		os.Exit(1)
	}

	raw, _ := resp["tags"].([]any)
	if len(raw) == 0 {
		fmt.Println("No tags.")
		return nil
	}
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if name, _ := m["name"].(string); name != "" {
			fmt.Println(name)
		}
	}
	return nil
}

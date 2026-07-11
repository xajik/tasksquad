package agentctx

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tasksquad/daemon/config"
)

func testConfig(serverURL string, agents ...config.AgentConfig) *config.Config {
	return &config.Config{
		Server: config.ServerConfig{URL: serverURL},
		Agents: agents,
	}
}

// ── CurrentAgentID ────────────────────────────────────────────────────────────

func TestCurrentAgentID_MatchesConfiguredWorkDir(t *testing.T) {
	cfg := testConfig("", config.AgentConfig{ID: "agent-1", WorkDir: "/Users/alice/projects/app"})

	got := CurrentAgentID(cfg, "/Users/alice/projects/app")
	if got != "agent-1" {
		t.Errorf("got %q, want agent-1", got)
	}
}

func TestCurrentAgentID_NoMatch(t *testing.T) {
	cfg := testConfig("", config.AgentConfig{ID: "agent-1", WorkDir: "/Users/alice/projects/app"})

	got := CurrentAgentID(cfg, "/Users/alice/projects/other")
	if got != "" {
		t.Errorf("got %q, want empty string", got)
	}
}

func TestCurrentAgentID_TrailingSlashNormalized(t *testing.T) {
	cfg := testConfig("", config.AgentConfig{ID: "agent-1", WorkDir: "/Users/alice/projects/app/"})

	got := CurrentAgentID(cfg, "/Users/alice/projects/app")
	if got != "agent-1" {
		t.Errorf("got %q, want agent-1", got)
	}
}

func TestCurrentAgentID_MultipleAgentsFirstMatchWins(t *testing.T) {
	cfg := testConfig("",
		config.AgentConfig{ID: "agent-1", WorkDir: "/work/a"},
		config.AgentConfig{ID: "agent-2", WorkDir: "/work/b"},
	)

	if got := CurrentAgentID(cfg, "/work/b"); got != "agent-2" {
		t.Errorf("got %q, want agent-2", got)
	}
}

// ── CurrentTeamID ─────────────────────────────────────────────────────────────

func TestCurrentTeamID_ResolvesViaUserAgentsEndpoint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/daemon/user/agents" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"agents": []map[string]any{
				{"id": "agent-1", "name": "coder", "team_id": "team-abc"},
				{"id": "agent-2", "name": "reviewer", "team_id": "team-xyz"},
			},
		})
	}))
	defer srv.Close()

	cfg := testConfig(srv.URL, config.AgentConfig{ID: "agent-2", WorkDir: "/work/app"})

	teamID, err := CurrentTeamID(cfg, "token", "/work/app")
	if err != nil {
		t.Fatalf("CurrentTeamID: %v", err)
	}
	if teamID != "team-xyz" {
		t.Errorf("got %q, want team-xyz", teamID)
	}
}

func TestCurrentTeamID_NoMatchingAgent(t *testing.T) {
	cfg := testConfig("http://unused", config.AgentConfig{ID: "agent-1", WorkDir: "/work/app"})

	_, err := CurrentTeamID(cfg, "token", "/work/somewhere-else")
	if err == nil {
		t.Fatal("expected error when workDir matches no configured agent")
	}
}

func TestCurrentTeamID_AgentMissingFromResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"agents": []map[string]any{
				{"id": "some-other-agent", "team_id": "team-abc"},
			},
		})
	}))
	defer srv.Close()

	cfg := testConfig(srv.URL, config.AgentConfig{ID: "agent-1", WorkDir: "/work/app"})

	_, err := CurrentTeamID(cfg, "token", "/work/app")
	if err == nil {
		t.Fatal("expected error when the resolved agent isn't in the response")
	}
}

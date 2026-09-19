package agent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/tasksquad/daemon/config"
	"github.com/zalando/go-keyring"
)

func TestSpawnFailureClosesSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture requires POSIX")
	}
	keyring.MockInit()
	keyring.Set("tasksquad-daemon", "cli-token", "tsq_cli_local_test")
	keyring.Set("tasksquad-daemon", "cli-token-expiry", time.Now().Add(30*24*time.Hour).Format(time.RFC3339))
	for _, name := range []string{"missing-command", "missing-tmux", "tmux-from-updated-path"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("HOME", dir)
			t.Setenv("PATH", dir)
			marker := filepath.Join(dir, "tmux-ran")
			t.Setenv("TSQ_TEST_MARKER", marker)
			if name == "tmux-from-updated-path" {
				// The real tmux was available during package init. Only the
				// current PATH should be used after app environment setup.
				if err := os.WriteFile(filepath.Join(dir, "tmux"), []byte("#!/bin/sh\n: > \"$TSQ_TEST_MARKER\"\nexit 1\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			closed := make(chan map[string]any, 2)
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/daemon/session/open":
					json.NewEncoder(w).Encode(map[string]string{"session_id": "spawn-failure-" + name})
				case "/daemon/session/close":
					var body map[string]any
					json.NewDecoder(r.Body).Decode(&body)
					closed <- body
					w.Write([]byte(`{}`))
				default:
					http.NotFound(w, r)
				}
			}))
			defer api.Close()
			cfg := &config.Config{}
			cfg.Server.URL = api.URL
			provider := "codex"
			if name == "missing-command" {
				provider = "stdout"
			}
			a := New(config.AgentConfig{ID: "agent", Name: "spawn-test", Command: "missing-cli", Provider: provider, WorkDir: dir})
			started := time.Now()
			a.startTask(cfg, map[string]any{"id": name, "subject": "test"}, "")
			if elapsed := time.Since(started); elapsed > 12*time.Second {
				t.Errorf("failure waited for a nonexistent output reader: %s", elapsed)
			}
			select {
			case body := <-closed:
				if body["status"] != "crashed" || body["session_id"] != "spawn-failure-"+name {
					t.Fatalf("incorrect session close: %v", body)
				}
			default:
				t.Fatal("spawn failure left server session open")
			}
			if a.GetMode() != "idle" || a.st.sessionID != "" || a.st.runLog != nil || a.st.taskLog != nil || a.st.outputDone != nil {
				t.Fatal("spawn failure leaked task resources")
			}
			data, err := os.ReadFile(filepath.Join(dir, ".tasksquad", "tasks", name+".jsonl"))
			if err != nil || !strings.Contains(string(data), `"type":"task_end"`) {
				t.Fatalf("missing task end record: %s, %v", data, err)
			}
			if name == "tmux-from-updated-path" {
				if _, err := os.Stat(marker); err != nil {
					t.Fatal("tmux was resolved before PATH setup", err)
				}
			}
		})
	}
}

package agent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/tasksquad/daemon/config"
	"github.com/zalando/go-keyring"
)

func TestParallelOffersRunTogetherAndCloseTheirOwnSessions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX process fixture")
	}
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	keyring.MockInit()
	keyring.Set("tasksquad-daemon", "cli-token", "tsq_cli_fixture")
	keyring.Set("tasksquad-daemon", "cli-token-expiry", time.Now().Add(24*time.Hour).Format(time.RFC3339))
	script := filepath.Join(dir, "provider")
	if err := os.WriteFile(script, []byte("#!/bin/sh\ntouch \"$TSQ_TASK_ID.ready\"\nwhile [ ! -f release ]; do sleep 0.05; done\necho \"$TSQ_TASK_ID\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	closed := make(chan string, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/daemon/session/open":
			json.NewEncoder(w).Encode(map[string]any{"session_id": body["task_id"]})
		case "/daemon/session/close":
			closed <- body["session_id"].(string)
			w.Write([]byte("{}"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	cfg := &config.Config{}
	cfg.Server.URL = server.URL
	a := New(config.AgentConfig{ID: "agent", Name: "parallel", Provider: "stdout", Command: script, WorkDir: dir})
	offers := []any{}
	for _, id := range []string{"first", "second", "first"} {
		offers = append(offers, map[string]any{"task": map[string]any{"id": id, "subject": "run"}})
	}
	a.processParallel(cfg, map[string]any{"offers": offers})
	defer os.WriteFile(filepath.Join(dir, "release"), nil, 0600)
	deadline := time.Now().Add(10 * time.Second)
	for _, id := range []string{"first", "second"} {
		for {
			if _, err := os.Stat(filepath.Join(dir, id+".ready")); err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("providers did not overlap")
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	if n := len(a.activeTasks()); n != 2 {
		t.Fatalf("got %d active tasks", n)
	}
	os.WriteFile(filepath.Join(dir, "release"), nil, 0600)
	seen := map[string]bool{}
	for len(seen) < 2 {
		select {
		case id := <-closed:
			seen[id] = true
		case <-time.After(10 * time.Second):
			t.Fatal("missing closes", seen)
		}
	}
	if !seen["first"] || !seen["second"] {
		t.Fatal(seen)
	}
	for len(a.activeTasks()) != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond * 10)
	}
}

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

// A PI turn posts its reply, reports the PI session for resuming and detaches
// (task stays open, agent idle); the follow-up re-spawns `pi --session <id>`
// with only the new reply.
func TestPiTurnDetachesAndFollowUpResumesTheSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture requires POSIX")
	}
	const id = "01a1807b-d4cf-732f-a57d-cc9414b962bd"
	keyring.MockInit()
	keyring.Set("tasksquad-daemon", "cli-token", "tsq_cli_local_test")
	keyring.Set("tasksquad-daemon", "cli-token-expiry", time.Now().Add(30*24*time.Hour).Format(time.RFC3339))
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("PI_CODING_AGENT_DIR", "")
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", "")
	sessions := filepath.Join(dir, ".pi", "agent", "sessions", "--work--")
	os.MkdirAll(sessions, 0o755)
	transcript := filepath.Join(sessions, "2026-10-28T03-00-00-000Z_"+id+".jsonl")
	work := filepath.Join(dir, "work")
	os.MkdirAll(work, 0o755)
	os.WriteFile(transcript, []byte(`{"type":"session","id":"`+id+`","cwd":"`+work+`"}`+"\n"), 0o644)
	// Stand-in PI: records its argv, then exits like `pi -p` after its turn.
	argv := filepath.Join(dir, "argv.txt")
	pi := filepath.Join(dir, "pi")
	os.WriteFile(pi, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \""+argv+"\"\nsleep 1\n"), 0o755)

	notified := make(chan map[string]any, 4)
	closed := make(chan map[string]any, 4)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/daemon/session/open":
			json.NewEncoder(w).Encode(map[string]string{"session_id": "pi-session"})
		case "/daemon/session/notify":
			notified <- body
			w.Write([]byte(`{"message_id":"m1"}`))
		case "/daemon/session/close":
			closed <- body
			w.Write([]byte(`{}`))
		default:
			w.Write([]byte(`{}`))
		}
	}))
	defer api.Close()
	cfg := &config.Config{}
	cfg.Server.URL = api.URL
	a := New(config.AgentConfig{ID: "agent", Name: "pi-test", Command: pi, Provider: "pi", WorkDir: work})

	run := func(task map[string]any, endTurn bool) {
		done := make(chan struct{})
		go func() { a.startTask(cfg, task, ""); close(done) }()
		deadline := time.Now().Add(5 * time.Second)
		for a.GetMode() != "running" || a.SessionID() == "" {
			if time.Now().After(deadline) {
				t.Fatal("task never started")
			}
			time.Sleep(10 * time.Millisecond)
		}
		// What the hook server does for PI's agent_end.
		if endTurn {
			a.PinCLISessionID(id)
			a.EndPipeTurn("answer", transcript)
		}
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Fatal("startTask did not return")
		}
	}

	run(map[string]any{"id": "t1", "subject": "s", "messages": []any{map[string]any{"role": "user", "body": "first question"}}}, true)
	n := <-notified
	if n["message"] != "answer" || n["provider"] != "pi" || n["provider_session_id"] != id {
		t.Fatalf("notify: %v", n)
	}
	c := <-closed
	if c["status"] != "detached" || c["resume_failed"] != false {
		t.Fatalf("close: %v", c)
	}
	if a.GetMode() != "idle" {
		t.Fatalf("agent must be free after the turn, mode=%s", a.GetMode())
	}

	followUp := map[string]any{"id": "t1", "subject": "s", "resume": map[string]any{"provider": "pi", "session_id": id},
		"messages": []any{
			map[string]any{"role": "user", "body": "first question"},
			map[string]any{"role": "agent", "body": "answer"},
			map[string]any{"role": "user", "body": "follow up"},
		}}
	run(followUp, true)
	data, _ := os.ReadFile(argv)
	args := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(args) < 4 || args[0] != "--session" || args[1] != id || args[len(args)-2] != "-p" || args[len(args)-1] != "follow up" {
		t.Fatalf("resumed argv: %q", args)
	}
	<-notified
	if c := <-closed; c["status"] != "detached" {
		t.Fatalf("second close: %v", c)
	}

	// A resumed run that exits 0 without a turn (Pi declining to fork a session
	// from another directory) is a failed resume: replay, never "done".
	run(followUp, false)
	if c := <-closed; c["status"] != "detached" || c["resume_failed"] != true {
		t.Fatalf("failed resume close: %v", c)
	}
}

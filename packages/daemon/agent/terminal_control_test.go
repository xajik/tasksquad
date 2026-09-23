package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"al.essio.dev/pkg/shellescape"
	"github.com/google/uuid"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/hooks"
	"github.com/tasksquad/daemon/tasklog"
	"github.com/zalando/go-keyring"
)

func TestManagedTerminalTwoTurnsAndScopedClose(t *testing.T) {
	realTmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux unavailable")
	}
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	socket := "tsq-control-" + uuid.NewString()[:8]
	wrapper := filepath.Join(dir, "tmux")
	if err := os.WriteFile(wrapper, []byte("#!/bin/sh\nexec "+shellescape.Quote(realTmux)+" -L "+shellescape.Quote(socket)+" \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	oldTmux := tmuxBin
	tmuxBin = wrapper
	defer func() { tmuxBin = oldTmux; exec.Command(wrapper, "kill-server").Run() }()
	run := func(args ...string) string {
		t.Helper()
		out, err := exec.Command(wrapper, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("tmux %v: %v %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	pane := run("-f", "/dev/null", "new-session", "-d", "-s", "tsq-owner", "-P", "-F", "#{pane_id}", "/bin/cat")
	other := run("new-session", "-d", "-s", "unrelated", "-P", "-F", "#{pane_id}", "/bin/cat")
	keyring.MockInit()
	keyring.Set("tasksquad-daemon", "cli-token", "tsq_cli_test")
	keyring.Set("tasksquad-daemon", "cli-token-expiry", time.Now().Add(30*24*time.Hour).Format(time.RFC3339))
	messages, closes := make(chan string, 10), make(chan string, 10)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if r.URL.Path == "/daemon/session/notify" {
			messages <- fmt.Sprint(body["message"])
		}
		if r.URL.Path == "/daemon/session/close" {
			closes <- fmt.Sprint(body["status"])
		}
		fmt.Fprint(w, `{}`)
	}))
	defer api.Close()
	cfg := &config.Config{}
	cfg.Server.URL = api.URL
	a := New(config.AgentConfig{ID: "agent", Name: "test", Provider: "codex", WorkDir: dir})
	a.st.taskID = "task"
	a.st.sessionID = "session"
	a.st.tmuxSession = "tsq-owner"
	a.st.mode = ModeRunning
	a.st.taskLog, err = tasklog.Open("task")
	if err != nil {
		t.Fatal(err)
	}
	h := hooks.NewHandler(cfg, []hooks.Agent{a}, nil, nil)
	call := func(path string, body any, origin string) int {
		t.Helper()
		data, _ := json.Marshal(body)
		req := httptest.NewRequest("POST", path, bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w.Code
	}
	waitMode := func(want string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for a.GetMode() != want && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if a.GetMode() != want {
			t.Fatalf("mode = %s; want %s", a.GetMode(), want)
		}
	}
	turn := func(id, text string) {
		if got := call("/hooks/codex?agent=agent&task_id=task", map[string]string{"type": "agent-turn-complete", "thread-id": "thread", "turn-id": id, "last-assistant-message": text}, ""); got != 200 {
			t.Fatal(got)
		}
	}
	waitMessage := func(want string) {
		t.Helper()
		select {
		case got := <-messages:
			if got != want {
				t.Fatalf("got %q want %q", got, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("missing message")
		}
		waitMode("waiting_input")
	}
	turn("1", "FIRST")
	waitMessage("FIRST")
	input := map[string]any{"agent_id": "agent", "task_id": "task", "session": "tsq-owner", "pane": pane, "data": []byte("café 猫\r"), "submit": true}
	if got := call("/hooks/terminal/input", input, "https://untrusted.example"); got != 403 {
		t.Fatal(got)
	}
	input["pane"] = other
	if got := call("/hooks/terminal/input", input, ""); got != 409 {
		t.Fatal("cross-session input", got)
	}
	input["pane"] = pane
	input["task_id"] = "stale"
	if got := call("/hooks/terminal/input", input, ""); got != 409 {
		t.Fatal("stale task input", got)
	}
	input["task_id"] = "task"
	if got := call("/hooks/terminal/input", input, ""); got != 204 {
		t.Fatal(got)
	}
	waitMode("running")
	if got := run("capture-pane", "-p", "-t", pane); !strings.Contains(got, "café 猫") {
		t.Fatalf("Unicode missing: %q", got)
	}
	turn("2", "SECOND café 猫")
	turn("2", "DUPLICATE")
	waitMessage("SECOND café 猫")
	select {
	case extra := <-messages:
		t.Fatal("duplicate message", extra)
	case <-time.After(50 * time.Millisecond):
	}
	journal, _ := os.ReadFile(filepath.Join(dir, ".tasksquad/tasks/task.jsonl"))
	if strings.Count(string(journal), `"type":"agent_turn"`) != 2 {
		t.Fatalf("missing journal replies: %s", journal)
	}
	closeBody := map[string]string{"agent_id": "agent", "task_id": "stale", "session": "tsq-owner"}
	if got := call("/hooks/terminal/close", closeBody, ""); got != 409 {
		t.Fatal("stale close", got)
	}
	closeBody["task_id"] = "task"
	if got := call("/hooks/terminal/close", closeBody, ""); got != 204 {
		t.Fatal(got)
	}
	select {
	case status := <-closes:
		if status != "closed" {
			t.Fatal(status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("missing close")
	}
	waitMode("idle")
	if err := exec.Command(wrapper, "has-session", "-t", "tsq-owner").Run(); err == nil {
		t.Fatal("session survived close")
	}
	run("has-session", "-t", "unrelated")
	if got := call("/hooks/terminal/close", closeBody, ""); got != 409 {
		t.Fatal("repeated close", got)
	}
}

func TestLatePausedReplyCannotChangeReplacementSession(t *testing.T) {
	keyring.MockInit()
	keyring.Set("tasksquad-daemon", "cli-token", "tsq_cli_test")
	keyring.Set("tasksquad-daemon", "cli-token-expiry", time.Now().Add(30*24*time.Hour).Format(time.RFC3339))
	for _, autoClose := range []bool{false, true} {
		t.Run(fmt.Sprint(autoClose), func(t *testing.T) {
			arrived, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			unblock := func() { once.Do(func() { close(release) }) }
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/daemon/session/notify" {
					close(arrived)
					<-release
				}
				fmt.Fprintf(w, `{"close":%t}`, autoClose)
			}))
			defer api.Close()
			defer unblock()
			cfg := &config.Config{}
			cfg.Server.URL = api.URL
			a := New(config.AgentConfig{ID: "agent", Provider: "codex", WorkDir: t.TempDir()})
			a.st.taskID = "old"
			a.st.sessionID = "old-session"
			a.st.mode = ModeRunning
			done := make(chan struct{})
			go func() { a.StopAndPause(cfg, "OLD REPLY", ""); close(done) }()
			select {
			case <-arrived:
			case <-time.After(5 * time.Second):
				t.Fatal("notify missing")
			}
			a.st.mu.Lock()
			a.st.taskID = "new"
			a.st.sessionID = "new-session"
			a.st.mode = ModeRunning
			a.st.mu.Unlock()
			unblock()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("callback did not finish")
			}
			if a.SessionID() != "new-session" || a.GetTaskID() != "new" || a.GetMode() != "running" {
				t.Fatal("late callback changed replacement task")
			}
		})
	}
}

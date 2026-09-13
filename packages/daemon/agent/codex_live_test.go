package agent

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"al.essio.dev/pkg/shellescape"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/hooks"
	"github.com/tasksquad/daemon/tmux"
	"github.com/zalando/go-keyring"
)

// Opt-in: runs the installed, authenticated Codex CLI in a disposable project.
// TaskSquad auth/API are local fixtures; no production task is created.
func TestCodexLiveTwoTurns(t *testing.T) {
	if os.Getenv("TSQ_CODEX_LIVE") != "1" {
		t.Skip("set TSQ_CODEX_LIVE=1 for the authenticated CLI integration test")
	}
	cli, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	if tmuxBin == "" {
		t.Fatal("tmux required")
	}
	// Use a disposable child of this already-trusted checkout. A new git root
	// would require persisting a personal trust decision, which this test avoids.
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(root, ".tsq", "codex-tests")
	if err := os.MkdirAll(parent, 0700); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(parent, "live-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)

	// Isolate tmux from the installed daemon's orphan sweep and user sessions.
	realTmux, _ := exec.LookPath("tmux")
	socket := "tsq-live-" + uuid.NewString()[:8]
	tmuxWrapper := filepath.Join(dir, "tmux")
	if err := os.WriteFile(tmuxWrapper, []byte("#!/bin/sh\nexec "+shellescape.Quote(realTmux)+" -L "+shellescape.Quote(socket)+" \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	oldTmux := tmuxBin
	tmuxBin = tmuxWrapper
	defer func() { tmuxBin = oldTmux }()
	defer exec.Command(realTmux, "-L", socket, "kill-server").Run()
	t.Logf("tmux socket: %s", socket)

	wrapper := filepath.Join(dir, "codex-live")
	script := "#!/bin/sh\nexec " + shellescape.Quote(cli) + " \"$@\" 2> " + shellescape.Quote(filepath.Join(dir, "stderr.log")) + "\n"
	if err := os.WriteFile(wrapper, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	keyring.MockInit()
	keyring.Set("tasksquad-daemon", "cli-token", "tsq_cli_local_test")
	keyring.Set("tasksquad-daemon", "cli-token-expiry", time.Now().Add(30*24*time.Hour).Format(time.RFC3339))
	id := "codex-live-" + uuid.NewString()[:8]
	messages := make(chan string, 10)
	var relayBytes atomic.Int64
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/terminal/") {
			conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer conn.Close()
			conn.WriteJSON(map[string]any{"t": "r", "c": 100, "r": 30})
			for {
				_, data, err := conn.ReadMessage()
				if err != nil {
					return
				}
				relayBytes.Add(int64(len(data)))
			}
		}
		if r.Header.Get("Authorization") != "Bearer tsq_cli_local_test" {
			http.Error(w, "auth", 401)
			return
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/daemon/session/open":
			json.NewEncoder(w).Encode(map[string]string{"session_id": id})
		case "/daemon/session/notify":
			messages <- fmt.Sprint(body["message"])
			fmt.Fprint(w, `{}`)
		case "/daemon/session/close":
			fmt.Fprint(w, `{}`)
		default:
			fmt.Fprint(w, `{}`)
		}
	}))
	defer api.Close()
	cfg := &config.Config{}
	cfg.Server.URL = api.URL
	a := New(config.AgentConfig{ID: id, Name: id, Command: wrapper, Provider: "codex", WorkDir: dir})
	hook := httptest.NewServer(hooks.NewHandler(cfg, []hooks.Agent{a}, nil, nil, nil))
	defer hook.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(hook.URL, "http://"))
	cfg.Hooks.Port, _ = strconv.Atoi(port)
	done := make(chan struct{})
	go func() {
		a.startTask(cfg, map[string]any{"id": id, "subject": "Reply exactly TSQ_ONE. Do not use tools."}, "")
		close(done)
	}()
	defer func() {
		tmux.KillSession("tsq-" + id)
		select {
		case <-done:
		case <-time.After(20 * time.Second):
		}
	}()
	waitMessage := func(want string) {
		t.Helper()
		select {
		case msg := <-messages:
			if !strings.Contains(msg, want) {
				t.Fatalf("got %q, want %s", msg, want)
			}
		case <-done:
			stderr, _ := os.ReadFile(filepath.Join(dir, "stderr.log"))
			t.Logf("stderr: %s", stderr)
			a.st.mu.Lock()
			lines := append([]string(nil), a.st.outputLines...)
			a.st.mu.Unlock()
			t.Fatalf("CLI exited early; mode=%s output=%q", a.GetMode(), lines)
		case <-time.After(90 * time.Second):
			t.Fatalf("missing %s; terminal: %s", want, tmux.CapturePane("tsq-"+id, 60))
		}
		deadline := time.Now().Add(5 * time.Second)
		for a.GetMode() != "waiting_input" && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if a.GetMode() != "waiting_input" {
			t.Fatal("did not pause", a.GetMode())
		}
	}
	waitMessage("TSQ_ONE")
	a.processResponse(cfg, map[string]any{"reply": "Reply exactly TSQ_TWO. Do not use tools."})
	waitMessage("TSQ_TWO")
	if relayBytes.Load() == 0 {
		t.Error("no terminal output relayed")
	}
	a.processResponse(cfg, map[string]any{"close": true})
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("CLI did not exit")
	}
	if tmux.HasSession("tsq-" + id) {
		t.Error("orphaned tmux session")
	}
}

package provider

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

func TestCodexNotifyArgv(t *testing.T) {
	if _, err := exec.LookPath("curl"); err != nil {
		t.Skip("curl required")
	}
	const payload = `{"type":"agent-turn-complete","thread-id":"thread","last-assistant-message":"quotes '\" and $HOME; $(false)\nnext"}`
	received := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		received <- string(data)
	}))
	defer srv.Close()
	args := codexNotifyArgs(srv.URL)
	var cfg struct {
		Notify []string `toml:"notify"`
	}
	if _, err := toml.Decode(args[1], &cfg); err != nil {
		t.Fatal(err)
	}
	argv := append(cfg.Notify[1:], payload)
	if out, err := exec.Command(cfg.Notify[0], argv...).CombinedOutput(); err != nil {
		t.Fatalf("callback: %v %s", err, out)
	}
	if got := <-received; got != payload {
		t.Fatalf("payload changed: %q", got)
	}
}

func TestCodexInvocationIsolation(t *testing.T) {
	p := &Codex{}
	a, b := p.SetupArgs(1234, "a&b", "task/one"), p.SetupArgs(1234, "other", "task/two")
	if a[1] == b[1] {
		t.Fatal("routing shared")
	}
	var cfg struct{ Notify []string }
	if _, err := toml.Decode(a[1], &cfg); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cfg.Notify[len(cfg.Notify)-1], "agent=a%26b") {
		t.Fatal(cfg.Notify)
	}
	if err := p.Setup("/nonexistent/unwritable", 1234, "a", "t"); err != nil {
		t.Fatal(err)
	}
	if p.Stdin("hello") != "hello" {
		t.Fatal("TUI prompt lost")
	}
	// JSON argv is valid TOML, including shell metacharacters.
	if _, err := json.Marshal(cfg.Notify); err != nil {
		t.Fatal(err)
	}
}

func TestCodexSkillPrompt(t *testing.T) {
	for in, want := range map[string]string{
		"/tsq-end-session-learning":              "$tsq-end-session-learning",
		"Load /tsq-kb-builder and /tsq-dreaming": "Load $tsq-kb-builder and $tsq-dreaming",
		"https://host/tsq-foo /help":             "https://host/tsq-foo /help",
	} {
		if got := FormatPrompt(&Codex{}, in); got != want {
			t.Errorf("%q => %q, want %q", in, got, want)
		}
	}
}

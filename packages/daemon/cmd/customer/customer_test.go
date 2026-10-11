package customer

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tasksquad/daemon/api"
)

func TestParseRequiresExplicitProjectAndBoundsTimeout(t *testing.T) {
	for _, args := range [][]string{{"tasks", "create", "--agent", "a", "--subject", "s"}, {"tasks", "wait", "--project", "p", "--id", "t", "--timeout", "31m"}, {"tasks", "close", "--project", "../p", "--id", "t"}} {
		if _, err := Parse(args); err == nil {
			t.Fatalf("accepted invalid command %v", args)
		}
	}
	o, err := Parse([]string{"tasks", "create", "--project", "01ABC", "--agent", "01DEF", "--subject", "build", "--timeout", "2m"})
	if err != nil || o.Timeout != 2*time.Minute {
		t.Fatalf("parse: %+v, %v", o, err)
	}
}

func TestExecuteScopesMutationsAndUsesUserAuthWithoutAgentHeader(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.RequestURI())
		if r.Header.Get("X-TSQ-Agent") != "" {
			t.Error("customer request carried daemon agent scope")
		}
		if r.URL.Path == "/tasks/task-1" {
			w.Write([]byte(`{"id":"task-1","team_id":"team-1","status":"waiting_input"}`))
			return
		}
		w.Write([]byte(`{"id":"message-1","ok":true}`))
	}))
	defer server.Close()
	client := api.CustomerClient{BaseURL: server.URL, Token: "private"}
	o := Options{Group: "tasks", Action: "reply", Project: "team-1", ID: "task-1", Body: "reply", Timeout: time.Second}
	_, err := Execute(context.Background(), client, o)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 2 || paths[0] != "GET /tasks/task-1" || paths[1] != "POST /tasks/task-1/messages" {
		t.Fatalf("unexpected API calls: %v", paths)
	}
}

func TestClientNeverForwardsCredentialsAcrossRedirects(t *testing.T) {
	var targetSawAuthorization string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetSawAuthorization = r.Header.Get("Authorization") }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer redirect.Close()
	client := api.CustomerClient{BaseURL: redirect.URL, Token: "private"}
	if _, err := client.Request(context.Background(), "GET", "/teams", nil, nil); err == nil {
		t.Fatal("redirect should fail")
	}
	if targetSawAuthorization != "" {
		t.Fatal("authorization forwarded across origin redirect")
	}
}

func TestEmitRedactsNestedCredentials(t *testing.T) {
	var out strings.Builder
	emit(&out, map[string]any{"token": "secret", "task": map[string]any{"refresh_token": "secret"}}, false)
	if strings.Contains(out.String(), "secret") || !strings.Contains(out.String(), "[redacted]") {
		t.Fatalf("bad redaction: %s", out.String())
	}
}

func TestProviderBaseMatchesProviderRepresentations(t *testing.T) {
	for provider, expected := range map[string]string{"claude-code": ".claude", "codex": ".agents", "opencode": ".agents", "gemini": ".gemini", "pi": ".pi", "claw": ".agent", "stdout": ""} {
		if got := providerBase(provider); got != expected {
			t.Errorf("providerBase(%q) = %q, want %q", provider, got, expected)
		}
	}
}

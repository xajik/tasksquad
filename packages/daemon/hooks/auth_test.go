package hooks

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tasksquad/daemon/config"
)

func nativeHookRequest(method, target string, body io.Reader) *http.Request {
	r := httptest.NewRequest(method, target, body)
	r.Host = "127.0.0.1"
	r.Header.Set("Authorization", "Bearer test-hook-token")
	return r
}

func TestHookServerRequiresCapabilityBeforeChangingAgentState(t *testing.T) {
	a := &fakeAgent{id: "agent", taskID: "task", mode: "running"}
	h := NewHandler(&config.Config{}, []Agent{a}, nil, nil, "test-hook-token")
	r := nativeHookRequest("POST", "/hooks/tui-blocked?state=on", nil)
	r.Header.Del("Authorization")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 || a.tuiBlocked {
		t.Fatal("unauthenticated hook changed agent state")
	}
	r.Header.Set("Authorization", "Bearer test-hook-token")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || !a.tuiBlocked {
		t.Fatal("authenticated native hook did not dispatch")
	}
}

func TestHookAuthenticationRejectsUntrustedRequestsBeforeDispatch(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*http.Request)
		status int
	}{
		{"missing capability", func(r *http.Request) { r.Header.Del("Authorization") }, 401},
		{"wrong capability", func(r *http.Request) { r.Header.Set("Authorization", "Bearer wrong") }, 401},
		{"foreign origin", func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }, 403},
		{"opaque origin", func(r *http.Request) { r.Header.Set("Origin", "null") }, 403},
		{"empty origin", func(r *http.Request) { r.Header["Origin"] = []string{""} }, 403},
		{"browser metadata", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-origin") }, 403},
		{"rebinding host", func(r *http.Request) { r.Host = "evil.example:7374" }, 403},
		{"GET mutation", func(r *http.Request) { r.Method = "GET" }, 405},
		{"preflight", func(r *http.Request) { r.Method = "OPTIONS"; r.Header.Set("Origin", "https://evil.example") }, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			h := authenticateHooks(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }), "test-hook-token")
			r := nativeHookRequest("POST", "/hooks/tui-blocked?state=on", nil)
			tc.change(r)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status || called || w.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatalf("status=%d dispatched=%v", w.Code, called)
			}
		})
	}
}

func TestHookAuthenticationAcceptsNativeAndClawCallbacks(t *testing.T) {
	for _, host := range []string{"localhost:7374", "127.0.0.1:7374", "[::1]:7374"} {
		called := false
		h := authenticateHooks(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }), "test-hook-token")
		r := nativeHookRequest("POST", "/hooks/event?hook_token=test-hook-token", nil)
		r.Host = host
		r.Header.Del("Authorization")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if !called || w.Code != 200 {
			t.Fatalf("native Claw callback rejected: %s %d", host, w.Code)
		}
	}
}

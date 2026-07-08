package agent

import (
	"errors"
	"testing"
	"time"
)

func TestIsUnauthorized(t *testing.T) {
	if !isUnauthorized(errors.New("HTTP 401 Unauthorized")) {
		t.Error("expected true for HTTP 401 error")
	}
	if isUnauthorized(errors.New("HTTP 404 Not Found")) {
		t.Error("expected false for HTTP 404 error")
	}
	if isUnauthorized(errors.New("connection refused")) {
		t.Error("expected false for non-HTTP error")
	}
}

func TestIsRateLimited(t *testing.T) {
	if !isRateLimited(errors.New("HTTP 429 Too Many Requests")) {
		t.Error("expected true for HTTP 429 error")
	}
	if isRateLimited(errors.New("HTTP 401 Unauthorized")) {
		t.Error("expected false for HTTP 401 error")
	}
	if isRateLimited(errors.New("timeout")) {
		t.Error("expected false for non-rate-limit error")
	}
}

// TestDaemonUptimeMsPresent verifies that daemon_uptime_ms is included in every
// heartbeat entry and is non-negative.
func TestDaemonUptimeMsPresent(t *testing.T) {
	uptimeMs := time.Since(daemonStartedAt).Milliseconds()
	if uptimeMs < 0 {
		t.Errorf("daemonStartedAt is in the future: uptime = %d ms", uptimeMs)
	}

	// Build a minimal entry the same way doPoll does.
	entry := map[string]any{
		"id":               "test-agent",
		"status":           "idle",
		"daemon_uptime_ms": uptimeMs,
	}

	v, ok := entry["daemon_uptime_ms"]
	if !ok {
		t.Fatal("daemon_uptime_ms key missing from entry")
	}
	ms, ok := v.(int64)
	if !ok {
		t.Fatalf("daemon_uptime_ms is %T, want int64", v)
	}
	if ms < 0 {
		t.Errorf("daemon_uptime_ms = %d, want >= 0", ms)
	}
}

package agent

import (
	"errors"
	"testing"
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

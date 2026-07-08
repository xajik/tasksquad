package agent

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"testing"
)

// TestPortalActiveCAS verifies the CAS guard prevents concurrent portal goroutines.
func TestPortalActiveCAS(t *testing.T) {
	var active int32

	// First acquisition succeeds
	if !atomic.CompareAndSwapInt32(&active, 0, 1) {
		t.Fatal("expected first CAS to succeed")
	}

	// Second acquisition fails while first holds the lock
	if atomic.CompareAndSwapInt32(&active, 0, 1) {
		t.Fatal("expected second CAS to fail while active=1")
	}

	// After release, acquisition succeeds again
	atomic.StoreInt32(&active, 0)
	if !atomic.CompareAndSwapInt32(&active, 0, 1) {
		t.Fatal("expected CAS to succeed after release")
	}
}

// TestPortalSignalDrain verifies that a stale signal in the buffered channel
// is drained before the close watcher starts, preventing it from firing
// on a signal from a previous portal invocation.
func TestPortalSignalDrain(t *testing.T) {
	ch := make(chan string, 1)

	// Simulate a stale signal left from the previous portal
	ch <- "old-portal-id"

	// Drain (mirrors the select at top of handlePortal)
	select {
	case <-ch:
	default:
	}

	// Channel must be empty — new portal's close watcher starts clean
	select {
	case got := <-ch:
		t.Fatalf("channel should be empty after drain, got %q", got)
	default:
	}
}

// TestPortalSignalDelivery verifies that a close signal for the current portal
// is correctly received after the drain.
func TestPortalSignalDelivery(t *testing.T) {
	ch := make(chan string, 1)

	// Drain any stale signal (none here)
	select {
	case <-ch:
	default:
	}

	// Close watcher receives the real signal
	ch <- "current-portal-id"

	select {
	case id := <-ch:
		if id != "current-portal-id" {
			t.Fatalf("expected current-portal-id, got %q", id)
		}
	default:
		t.Fatal("expected signal not received")
	}
}

// TestToFloat64 tests the JSON number conversion helper used in resize frame parsing.
func TestToFloat64(t *testing.T) {
	tests := []struct {
		v    any
		want float64
	}{
		{float64(80), 80},
		{float64(24), 24},
		{float64(0), 0},
		{"not a number", 0},
		{nil, 0},
		{true, 0},
		{42, 0}, // int (not float64) → 0
	}
	for _, tc := range tests {
		got := toFloat64(tc.v)
		if got != tc.want {
			t.Errorf("toFloat64(%v) = %v, want %v", tc.v, got, tc.want)
		}
	}
}

// TestStdinFrameParsing tests the stdin JSON frame parsing mirrored in handleRelayInput.
func TestStdinFrameParsing(t *testing.T) {
	input := "ls\n"
	encoded := base64.StdEncoding.EncodeToString([]byte(input))
	msg := []byte(fmt.Sprintf(`{"t":"i","d":%q}`, encoded))

	var frame map[string]any
	if err := json.Unmarshal(msg, &frame); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if frame["t"] != "i" {
		t.Errorf("type = %v, want 'i'", frame["t"])
	}
	encodedStr, _ := frame["d"].(string)
	data, err := base64.StdEncoding.DecodeString(encodedStr)
	if err != nil {
		t.Fatalf("base64 decode failed: %v", err)
	}
	if string(data) != input {
		t.Errorf("decoded = %q, want %q", data, input)
	}
}

// TestResizeFrameParsing tests the resize JSON frame parsing mirrored in handleRelayInput.
func TestResizeFrameParsing(t *testing.T) {
	msg := []byte(`{"t":"r","c":120,"r":40}`)

	var frame map[string]any
	if err := json.Unmarshal(msg, &frame); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if frame["t"] != "r" {
		t.Errorf("type = %v, want 'r'", frame["t"])
	}
	cols := int(toFloat64(frame["c"]))
	rows := int(toFloat64(frame["r"]))
	if cols != 120 {
		t.Errorf("cols = %d, want 120", cols)
	}
	if rows != 40 {
		t.Errorf("rows = %d, want 40", rows)
	}
}

// TestCloseNowExtraction verifies the bool extraction from the reportPortalOpen
// response map — the same pattern used in portal.go.
func TestCloseNowExtraction(t *testing.T) {
	tests := []struct {
		resp     map[string]any
		wantBool bool
	}{
		{map[string]any{"ok": true, "close_now": true}, true},
		{map[string]any{"ok": true, "close_now": false}, false},
		{map[string]any{"ok": true}, false},              // key absent → false
		{map[string]any{"close_now": "yes"}, false},      // wrong type → false
		{map[string]any{}, false},                         // empty map → false
	}

	for _, tc := range tests {
		closeNow, _ := tc.resp["close_now"].(bool)
		if closeNow != tc.wantBool {
			t.Errorf("resp=%v: got close_now=%v, want %v", tc.resp, closeNow, tc.wantBool)
		}
	}
}

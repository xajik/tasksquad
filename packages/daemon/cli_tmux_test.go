//go:build integration

package main_test

// Integration tests for the tsq CLI commands that interact with tmux:
//
//	tsq pane  <session> [--lines N]  — capture pane output
//	tsq send  <session> [<text>]     — send keys (text + wait + Enter, or bare Enter)
//	tsq report --task ... --status ... --summary ...  — POST verdict to hooks API
//
// These tests build the tsq binary once via TestMain, then exercise each
// command against real tmux sessions.
//
// Run with:
//
//	go test -v -tags integration -run TestTsq -timeout 60s ./...

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// cliBin is the path to the compiled tsq binary, built once by TestMain.
var cliBin string

// TestMain builds the tsq binary once for the whole package test run.
// All CLI tests share this binary; it is removed on exit.
func TestMain(m *testing.M) {
	dir, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "getwd: %v\n", err)
		os.Exit(1)
	}

	bin := fmt.Sprintf("%s/tsq-cli-test-%d", os.TempDir(), os.Getpid())
	cmd := exec.Command("go", "build", "-o", bin, ".")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "build tsq: %v\n%s\n", err, out)
		os.Exit(1)
	}
	cliBin = bin

	code := m.Run()
	os.Remove(bin) //nolint:errcheck
	os.Exit(code)
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// requireTmux skips the test if tmux is not available on PATH.
func requireTmux(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not found on PATH — skipping")
	}
}

// newTmuxSession creates a detached tmux session running cmd inside sh.
// The session is uniquely named with the given suffix and the test PID.
// A cleanup is registered to kill the session when the test ends.
func newTmuxSession(t *testing.T, suffix, cmd string) string {
	t.Helper()
	name := fmt.Sprintf("tsq-clitest-%s-%d", suffix, os.Getpid())
	args := []string{"new-session", "-d", "-s", name, "-x", "220", "-y", "50",
		"--", "sh", "-c", cmd}
	if out, err := exec.Command("tmux", args...).CombinedOutput(); err != nil {
		t.Fatalf("tmux new-session: %v: %s", err, out)
	}
	t.Cleanup(func() {
		exec.Command("tmux", "kill-session", "-t", name).Run() //nolint:errcheck
	})
	return name
}

// rawCapturePane calls tmux directly to capture the last n lines of a session.
// Used to verify state after tsq send, without going through the tsq binary.
func rawCapturePane(t *testing.T, session string, lines int) string {
	t.Helper()
	out, err := exec.Command("tmux", "capture-pane", "-t", session, "-p",
		"-S", fmt.Sprintf("-%d", lines)).Output()
	if err != nil {
		t.Fatalf("tmux capture-pane: %v", err)
	}
	return string(out)
}

// pollPane retries rawCapturePane until the output contains substr or deadline passes.
func pollPane(t *testing.T, session, substr string, timeout time.Duration) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if strings.Contains(rawCapturePane(t, session, 200), substr) {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// startMockHooksServer starts an HTTP server and registers /hooks/supervisor.
// It delivers the raw request body to the returned channel on each POST.
// The test owns closing the server via t.Cleanup.
func startMockHooksServer(t *testing.T) (port int, bodies <-chan []byte) {
	t.Helper()
	ch := make(chan []byte, 4)
	mux := http.NewServeMux()
	mux.HandleFunc("/hooks/supervisor", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, _ := io.ReadAll(r.Body)
		ch <- body
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`)) //nolint:errcheck
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	port = ln.Addr().(*net.TCPAddr).Port
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln) //nolint:errcheck
	t.Cleanup(func() { srv.Close() })

	// Wait for the server to be ready.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 50*time.Millisecond); err == nil {
			conn.Close()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	return port, ch
}

// ── tsq pane ───────────────────────────────────────────────────────────────────

// TestTsqPane verifies that `tsq pane <session>` returns visible pane content.
func TestTsqPane(t *testing.T) {
	requireTmux(t)

	const sentinel = "TSQPANE_SENTINEL_001"
	session := newTmuxSession(t, "pane", fmt.Sprintf("echo %s; sleep 60", sentinel))

	// Wait for the echo to land in the pane.
	if !pollPane(t, session, sentinel, 5*time.Second) {
		t.Fatalf("sentinel %q never appeared in raw pane", sentinel)
	}

	out, err := exec.Command(cliBin, "pane", session).CombinedOutput()
	if err != nil {
		t.Fatalf("tsq pane: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), sentinel) {
		t.Errorf("tsq pane output missing sentinel %q\ngot:\n%s", sentinel, out)
	}
}

// TestTsqPaneLinesFlag verifies that `tsq pane --lines N` limits captured output.
// Uses a 5-row terminal so that echoing 20 lines forces the first 15 into
// scrollback — making the --lines boundary testable.
func TestTsqPaneLinesFlag(t *testing.T) {
	requireTmux(t)

	// 5-row terminal: echoing 20 lines pushes the first 15 into scrollback.
	name := fmt.Sprintf("tsq-clitest-panelines-%d", os.Getpid())
	args := []string{
		"new-session", "-d", "-s", name,
		"-x", "220", "-y", "5", // narrow terminal to force scrollback
		"--", "sh", "-c", "for i in $(seq 1 20); do echo LINE_$i; done; sleep 60",
	}
	if out, err := exec.Command("tmux", args...).CombinedOutput(); err != nil {
		t.Fatalf("tmux new-session: %v: %s", err, out)
	}
	t.Cleanup(func() { exec.Command("tmux", "kill-session", "-t", name).Run() }) //nolint:errcheck

	if !pollPane(t, name, "LINE_20", 5*time.Second) {
		t.Fatal("output never fully appeared in raw pane")
	}

	// --lines 5: captures only the 5 most recent lines (LINE_16..LINE_20 + prompt).
	short, err := exec.Command(cliBin, "pane", name, "--lines", "5").CombinedOutput()
	if err != nil {
		t.Fatalf("tsq pane --lines 5: %v\n%s", err, short)
	}
	// Most recent line must be present.
	if !strings.Contains(string(short), "LINE_20") {
		t.Errorf("--lines 5 should include LINE_20\ngot:\n%s", short)
	}
	// First line must have scrolled out of the 5-line window.
	if strings.Contains(string(short), "LINE_1\n") {
		t.Errorf("--lines 5 should not include LINE_1\ngot:\n%s", short)
	}

	// Default capture (200 lines) must include the early lines that scrolled off.
	full, err := exec.Command(cliBin, "pane", name).CombinedOutput()
	if err != nil {
		t.Fatalf("tsq pane (default): %v\n%s", err, full)
	}
	if !strings.Contains(string(full), "LINE_1") {
		t.Errorf("default capture should include LINE_1\ngot:\n%s", full)
	}
}

// TestTsqPaneUnknownSession verifies that `tsq pane` exits non-zero for a
// session that does not exist.
func TestTsqPaneUnknownSession(t *testing.T) {
	requireTmux(t)

	out, err := exec.Command(cliBin, "pane", "tsq-no-such-session-xyz").CombinedOutput()
	if err == nil {
		t.Errorf("expected non-zero exit for unknown session, got success\noutput: %s", out)
	}
}

// ── tsq send ──────────────────────────────────────────────────────────────────

// TestTsqSendText verifies that `tsq send <session> <text>` delivers text + Enter.
// Uses `cat` as the target process — it echoes back whatever it reads from stdin.
func TestTsqSendText(t *testing.T) {
	requireTmux(t)

	const sentinel = "TSQSEND_TEXT_002"
	session := newTmuxSession(t, "sendtxt", "cat")
	time.Sleep(300 * time.Millisecond) // let cat start

	out, err := exec.Command(cliBin, "send", session, sentinel).CombinedOutput()
	if err != nil {
		t.Fatalf("tsq send: %v\n%s", err, out)
	}

	// cat echoes the input; poll until sentinel appears in the pane.
	if !pollPane(t, session, sentinel, 5*time.Second) {
		t.Errorf("sentinel %q never appeared after tsq send\npane:\n%s",
			sentinel, rawCapturePane(t, session, 50))
	}
}

// TestTsqSendEnter verifies that `tsq send <session>` (no text) sends a bare Enter.
// The session runs `read x && echo ENTER_RECEIVED; sleep 60` so the pane stays
// alive after the echo, giving pollPane time to observe the result.
func TestTsqSendEnter(t *testing.T) {
	requireTmux(t)

	session := newTmuxSession(t, "sendenter",
		`read x && echo ENTER_RECEIVED; sleep 60`)
	time.Sleep(300 * time.Millisecond) // let read start

	out, err := exec.Command(cliBin, "send", session).CombinedOutput()
	if err != nil {
		t.Fatalf("tsq send (no text): %v\n%s", err, out)
	}

	if !pollPane(t, session, "ENTER_RECEIVED", 5*time.Second) {
		t.Errorf("ENTER_RECEIVED never appeared after bare Enter\npane:\n%s",
			rawCapturePane(t, session, 50))
	}
}

// TestTsqSendMultiple verifies that calling tsq send twice delivers both inputs.
func TestTsqSendMultiple(t *testing.T) {
	requireTmux(t)

	session := newTmuxSession(t, "sendmulti", "cat")
	time.Sleep(300 * time.Millisecond)

	for _, word := range []string{"FIRST_003", "SECOND_004"} {
		if out, err := exec.Command(cliBin, "send", session, word).CombinedOutput(); err != nil {
			t.Fatalf("tsq send %q: %v\n%s", word, err, out)
		}
	}

	pane := rawCapturePane(t, session, 100)
	for _, word := range []string{"FIRST_003", "SECOND_004"} {
		if !strings.Contains(pane, word) {
			t.Errorf("pane missing %q after send\npane:\n%s", word, pane)
		}
	}
}

// ── tsq report ────────────────────────────────────────────────────────────────

// TestTsqReport verifies that `tsq report` POSTs the correct JSON payload.
func TestTsqReport(t *testing.T) {
	port, bodies := startMockHooksServer(t)

	out, err := exec.Command(cliBin, "report",
		"--task", "01KKTPERM001TEST",
		"--status", "resolved",
		"--summary", "agent was blocked on y/n",
		"--found", "Allow? prompt waiting",
		"--action", "sent y",
		"--port", fmt.Sprintf("%d", port),
	).CombinedOutput()
	if err != nil {
		t.Fatalf("tsq report: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "HTTP 200") {
		t.Errorf("expected HTTP 200 in output, got: %s", out)
	}

	select {
	case body := <-bodies:
		var p struct {
			TaskID  string `json:"task_id"`
			Status  string `json:"status"`
			Summary string `json:"summary"`
			Found   string `json:"found"`
			Action  string `json:"action"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			t.Fatalf("parse request body: %v\nbody: %s", err, body)
		}
		if p.TaskID != "01KKTPERM001TEST" {
			t.Errorf("task_id: got %q, want %q", p.TaskID, "01KKTPERM001TEST")
		}
		if p.Status != "resolved" {
			t.Errorf("status: got %q, want %q", p.Status, "resolved")
		}
		if p.Summary != "agent was blocked on y/n" {
			t.Errorf("summary: got %q, want %q", p.Summary, "agent was blocked on y/n")
		}
		if p.Found != "Allow? prompt waiting" {
			t.Errorf("found: got %q, want %q", p.Found, "Allow? prompt waiting")
		}
		if p.Action != "sent y" {
			t.Errorf("action: got %q, want %q", p.Action, "sent y")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for POST to /hooks/supervisor")
	}
}

// TestTsqReportDefaultAction verifies that --action defaults to "none" when omitted.
func TestTsqReportDefaultAction(t *testing.T) {
	port, bodies := startMockHooksServer(t)

	exec.Command(cliBin, "report", //nolint:errcheck
		"--task", "01KKTPERM001TEST",
		"--status", "working_fine",
		"--summary", "agent is healthy",
		"--port", fmt.Sprintf("%d", port),
	).Run()

	select {
	case body := <-bodies:
		var p struct {
			Action string `json:"action"`
		}
		json.Unmarshal(body, &p) //nolint:errcheck
		if p.Action != "none" {
			t.Errorf("default action: got %q, want %q", p.Action, "none")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for POST")
	}
}

// TestTsqReportMissingRequired verifies that tsq report exits non-zero when
// required flags (--task, --status, --summary) are omitted.
func TestTsqReportMissingRequired(t *testing.T) {
	// Missing --summary.
	out, err := exec.Command(cliBin, "report",
		"--task", "01KKTPERM001TEST",
		"--status", "resolved",
	).CombinedOutput()
	if err == nil {
		t.Errorf("expected non-zero exit when --summary omitted\noutput: %s", out)
	}

	// Missing --task entirely.
	out, err = exec.Command(cliBin, "report",
		"--status", "resolved",
		"--summary", "something",
	).CombinedOutput()
	if err == nil {
		t.Errorf("expected non-zero exit when --task omitted\noutput: %s", out)
	}
}

// TestTsqReportServerError verifies that tsq report exits non-zero when the
// hooks server returns a non-2xx response.
func TestTsqReportServerError(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/hooks/supervisor", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no active agent", http.StatusNotFound)
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln) //nolint:errcheck
	t.Cleanup(func() { srv.Close() })

	out, err := exec.Command(cliBin, "report",
		"--task", "01KKTPERM001TEST",
		"--status", "resolved",
		"--summary", "test",
		"--port", fmt.Sprintf("%d", port),
	).CombinedOutput()
	if err == nil {
		t.Errorf("expected non-zero exit on 404 response\noutput: %s", out)
	}
	if !strings.Contains(string(out), "HTTP 404") {
		t.Errorf("expected HTTP 404 in output, got: %s", out)
	}
}

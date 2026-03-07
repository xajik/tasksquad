//go:build integration

package main_test

// Integration test: spawns `claude -p <prompt>`, captures output via the Claude Code
// Stop hook (same mechanism used by the daemon), and writes the full session to a file.
//
// Run with:
//
//	go test -v -tags integration -run TestClaudeCodeSession -timeout 120s ./...

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// testPrompt is intentionally simple so the test runs fast.
const testPrompt = "Reply with exactly one word: DONE"

// testTimeout is the hard deadline for the whole test (claude + hook wait).
const testTimeout = 90 * time.Second

func TestClaudeCodeSession(t *testing.T) {
	// ── 1. Temp work dir (claude runs here; hooks written here) ───────────────
	workDir := t.TempDir()
	t.Logf("Work dir: %s", workDir)

	// ── 2. Find a free port for our inline hooks server ───────────────────────
	port := freePort(t)
	t.Logf("Hooks port: %d", port)

	// ── 3. Write .claude/settings.json with Stop + Notification hooks ─────────
	writeTestHooks(t, workDir, port)

	// ── 4. Start inline hooks capture server ──────────────────────────────────
	var (
		stopOnce   sync.Once
		stopCh     = make(chan string, 1) // receives stop_reason
		notifLines []string
		notifMu    sync.Mutex
	)

	srv := startTestHooksServer(t, port,
		func(stopReason string) { // /hooks/stop
			stopOnce.Do(func() { stopCh <- stopReason })
		},
		func(message string) { // /hooks/notification
			notifMu.Lock()
			notifLines = append(notifLines, message)
			notifMu.Unlock()
			t.Logf("[notification] %s", message)
		},
	)
	defer srv.Shutdown(context.Background()) //nolint:errcheck

	// ── 5. Spawn claude ────────────────────────────────────────────────────────
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "claude", "-p", testPrompt)
	cmd.Dir = workDir
	// Strip CLAUDECODE so the test can run from inside a Claude Code session.
	cmd.Env = filterEnv(os.Environ(), "CLAUDECODE")

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatalf("StderrPipe: %v", err)
	}

	if err := cmd.Start(); err != nil {
		t.Fatalf("start claude: %v\n(is `claude` on PATH?)", err)
	}
	t.Logf("claude PID: %d", cmd.Process.Pid)

	// ── 6. Stream stdout and stderr ───────────────────────────────────────────
	var (
		outputLines []string
		outputMu    sync.Mutex
		readerDone  = make(chan struct{})
	)

	readLines := func(r *bufio.Scanner, prefix string) {
		for r.Scan() {
			line := r.Text()
			outputMu.Lock()
			outputLines = append(outputLines, line)
			outputMu.Unlock()
			t.Logf("%s %s", prefix, line)
		}
	}

	go func() {
		defer close(readerDone)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); readLines(bufio.NewScanner(stdout), "[stdout]") }()
		go func() { defer wg.Done(); readLines(bufio.NewScanner(stderr), "[stderr]") }()
		wg.Wait()
	}()

	// ── 7. Wait for Stop hook OR process exit ─────────────────────────────────
	exitCh := make(chan error, 1)
	go func() {
		<-readerDone
		exitCh <- cmd.Wait()
	}()

	var stopReason string
	select {
	case reason := <-stopCh:
		stopReason = reason
		t.Logf("Stop hook received — stop_reason=%q", stopReason)
		// Give readers a moment to drain remaining output
		select {
		case <-readerDone:
		case <-time.After(3 * time.Second):
		}

	case exitErr := <-exitCh:
		if exitErr != nil {
			t.Logf("Process exited with error: %v", exitErr)
		} else {
			t.Logf("Process exited cleanly")
		}
		stopReason = "process_exit"

	case <-ctx.Done():
		t.Fatal("Test timed out waiting for claude to finish")
	}

	// ── 8. Build session record ───────────────────────────────────────────────
	outputMu.Lock()
	captured := append([]string(nil), outputLines...)
	outputMu.Unlock()

	notifMu.Lock()
	notifications := append([]string(nil), notifLines...)
	notifMu.Unlock()

	if len(captured) == 0 {
		t.Error("No output captured from claude — check that claude is correctly installed")
	}

	// ── 9. Write session file ─────────────────────────────────────────────────
	sessionPath := writeSessionFile(t, testPrompt, stopReason, captured, notifications)
	t.Logf("Session written to: %s", sessionPath)

	// ── 10. Basic assertions ──────────────────────────────────────────────────
	full := strings.Join(captured, "\n")
	if full == "" {
		t.Error("Session output is empty")
	}
	t.Logf("Captured %d lines, %d bytes", len(captured), len(full))
}

// filterEnv returns os.Environ() with any vars matching the given keys removed.
func filterEnv(env []string, exclude ...string) []string {
	out := make([]string, 0, len(env))
	for _, e := range env {
		skip := false
		for _, ex := range exclude {
			if strings.HasPrefix(e, ex+"=") || e == ex {
				skip = true
				break
			}
		}
		if !skip {
			out = append(out, e)
		}
	}
	return out
}

// ── Helpers ────────────────────────────────────────────────────────────────────

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("find free port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}

func writeTestHooks(t *testing.T, workDir string, port int) {
	t.Helper()
	claudeDir := filepath.Join(workDir, ".claude")
	if err := os.MkdirAll(claudeDir, 0755); err != nil {
		t.Fatalf("mkdir .claude: %v", err)
	}

	settings := map[string]any{
		"hooks": map[string]any{
			"Stop": []any{
				map[string]any{
					"matcher": "",
					"hooks": []any{
						map[string]any{
							"type":    "command",
							"command": fmt.Sprintf(`curl -s -X POST http://localhost:%d/hooks/stop -H 'Content-Type: application/json' -d @-`, port),
						},
					},
				},
			},
			"Notification": []any{
				map[string]any{
					"matcher": "",
					"hooks": []any{
						map[string]any{
							"type":    "command",
							"command": fmt.Sprintf(`curl -s -X POST http://localhost:%d/hooks/notification -H 'Content-Type: application/json' -d @-`, port),
						},
					},
				},
			},
		},
	}

	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		t.Fatalf("marshal hooks: %v", err)
	}
	if err := os.WriteFile(filepath.Join(claudeDir, "settings.json"), data, 0644); err != nil {
		t.Fatalf("write settings.json: %v", err)
	}
}

func startTestHooksServer(t *testing.T, port int, onStop func(string), onNotif func(string)) *http.Server {
	t.Helper()

	mux := http.NewServeMux()

	mux.HandleFunc("/hooks/stop", func(w http.ResponseWriter, r *http.Request) {
		var p struct {
			StopReason string `json:"stop_reason"`
			SessionID  string `json:"session_id"`
		}
		json.NewDecoder(r.Body).Decode(&p) //nolint:errcheck
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok")) //nolint:errcheck
		onStop(p.StopReason)
	})

	mux.HandleFunc("/hooks/notification", func(w http.ResponseWriter, r *http.Request) {
		var p struct {
			Message string `json:"message"`
		}
		json.NewDecoder(r.Body).Decode(&p) //nolint:errcheck
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok")) //nolint:errcheck
		if onNotif != nil {
			onNotif(p.Message)
		}
	})

	srv := &http.Server{
		Addr:    fmt.Sprintf("127.0.0.1:%d", port),
		Handler: mux,
	}
	go srv.ListenAndServe() //nolint:errcheck

	// Wait until the server is ready
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 100*time.Millisecond)
		if err == nil {
			conn.Close()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	return srv
}

// writeSessionFile writes a structured session record to ~/.tasksquad/logs/test-session-<unix>.txt
// and returns the path.
func writeSessionFile(t *testing.T, prompt, stopReason string, outputLines, notifications []string) string {
	t.Helper()

	home, err := os.UserHomeDir()
	if err != nil {
		t.Logf("UserHomeDir: %v", err)
		home = os.TempDir()
	}

	logsDir := filepath.Join(home, ".tasksquad", "logs")
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		t.Fatalf("mkdir logs: %v", err)
	}

	sessionPath := filepath.Join(logsDir, fmt.Sprintf("test-session-%d.txt", time.Now().Unix()))

	var sb strings.Builder
	sb.WriteString("=== TaskSquad CLI Integration Test Session ===\n")
	sb.WriteString(fmt.Sprintf("Time:        %s\n", time.Now().Format(time.RFC3339)))
	sb.WriteString(fmt.Sprintf("Prompt:      %s\n", prompt))
	sb.WriteString(fmt.Sprintf("Stop reason: %s\n", stopReason))
	sb.WriteString(fmt.Sprintf("Lines:       %d\n", len(outputLines)))
	sb.WriteString("\n--- OUTPUT ---\n")
	for _, l := range outputLines {
		sb.WriteString(l)
		sb.WriteByte('\n')
	}
	if len(notifications) > 0 {
		sb.WriteString("\n--- NOTIFICATIONS ---\n")
		for _, n := range notifications {
			sb.WriteString(n)
			sb.WriteByte('\n')
		}
	}
	sb.WriteString("\n=== END ===\n")

	if err := os.WriteFile(sessionPath, []byte(sb.String()), 0644); err != nil {
		t.Fatalf("write session file: %v", err)
	}
	return sessionPath
}

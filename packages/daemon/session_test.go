//go:build integration

package main_test

// Integration test: runs claude in interactive mode (no -p flag) inside a real
// tmux session, streams output through tmux pipe-pane → FIFO, and asserts that
// the Claude Code Stop hook delivers a transcript with a reply ≠ the input.
//
// The test uses the project root as workDir so Claude does not show the
// "trust this folder" safety dialog (the directory is already trusted).
//
// Run with:
//
//	go test -v -tags integration -run TestClaudeCodeTmuxSession -timeout 120s ./...
//
// NOTE: the test temporarily overwrites .claude/settings.json hooks in the
// project root and restores them on exit. Do not run it while the daemon is
// actively handling tasks in the same directory.

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
	"syscall"
	"testing"
	"time"

	"github.com/tasksquad/daemon/agent"
)

// testPrompt is simple so the test completes quickly.
const testPrompt = "Reply with exactly one word: DONE"

// testTimeout is the hard deadline for the whole test.
const testTimeout = 90 * time.Second

func TestClaudeCodeTmuxSession(t *testing.T) {
	// ── 0. Prerequisites ──────────────────────────────────────────────────────
	tmuxBin, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not found on PATH — skipping")
	}
	if _, err := exec.LookPath("claude"); err != nil {
		t.Skip("claude not found on PATH — skipping")
	}

	// ── 1. Work dir: project root (already trusted by Claude Code) ────────────
	// Test runs from packages/daemon/ → ../../ is the project root.
	daemonDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd: %v", err)
	}
	workDir, err := filepath.Abs(filepath.Join(daemonDir, "..", ".."))
	if err != nil {
		t.Fatalf("filepath.Abs: %v", err)
	}
	t.Logf("Work dir: %s", workDir)

	// ── 2. Hooks: overwrite only the hooks key, restore on exit ───────────────
	port := freePort(t)
	t.Logf("Hooks port: %d", port)
	t.Cleanup(writeTestHooks(t, workDir, port))

	// ── 3. Hooks capture server ───────────────────────────────────────────────
	var (
		stopOnce sync.Once
		stopCh   = make(chan stopEvent, 1)
	)
	srv := startTestHooksServer(t, port,
		func(ev stopEvent) { stopOnce.Do(func() { stopCh <- ev }) },
		func(msg string) { t.Logf("[notification] %s", msg) },
	)
	defer srv.Shutdown(context.Background()) //nolint:errcheck

	// ── 4. FIFO ───────────────────────────────────────────────────────────────
	fifoPath := filepath.Join(t.TempDir(), "output.fifo")
	if err := syscall.Mkfifo(fifoPath, 0644); err != nil {
		t.Fatalf("mkfifo: %v", err)
	}

	// ── 5. Start tmux session running claude in interactive mode ──────────────
	sessionName := fmt.Sprintf("ts-test-%d", os.Getpid())
	env := filterEnv(os.Environ(), "CLAUDECODE") // prevent Claude-in-Claude recursion

	newSessCmd := exec.Command(tmuxBin,
		"new-session", "-d", "-s", sessionName,
		"-c", workDir, "-x", "220", "-y", "50",
		"--", "claude",
	)
	newSessCmd.Env = env
	if out, err := newSessCmd.CombinedOutput(); err != nil {
		t.Fatalf("tmux new-session: %v: %s", err, out)
	}
	t.Logf("tmux session started: %s", sessionName)

	t.Cleanup(func() {
		exec.Command(tmuxBin, "kill-session", "-t", sessionName).Run() //nolint:errcheck
		os.Remove(fifoPath)
	})

	// ── 6. pipe-pane → FIFO + open reader ────────────────────────────────────
	fifoCh := make(chan *os.File, 1)
	go func() {
		f, err := os.Open(fifoPath) // blocks until pipe-pane opens write end
		if err != nil {
			t.Logf("FIFO open error: %v", err)
			return
		}
		fifoCh <- f
	}()

	exec.Command(tmuxBin, "pipe-pane", "-t", sessionName, "cat > "+fifoPath).Run() //nolint:errcheck

	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()

	var fifoFile *os.File
	select {
	case fifoFile = <-fifoCh:
		t.Logf("FIFO open — streaming output")
	case <-time.After(5 * time.Second):
		t.Fatal("FIFO open timed out")
	}

	// ── 7. Stream FIFO in background ──────────────────────────────────────────
	var (
		outputLines []string
		outputMu    sync.Mutex
		readerDone  = make(chan struct{})
	)
	go func() {
		defer close(readerDone)
		scanner := bufio.NewScanner(fifoFile)
		for scanner.Scan() {
			line := scanner.Text()
			outputMu.Lock()
			outputLines = append(outputLines, line)
			outputMu.Unlock()
			t.Logf("[fifo] %s", line)
		}
	}()

	// ── 8. Wait for Claude's interactive prompt, then send the task ───────────
	// Give the TUI time to finish rendering its startup screen.
	time.Sleep(3 * time.Second)
	exec.Command(tmuxBin, "send-keys", "-t", sessionName, testPrompt, "Enter").Run() //nolint:errcheck
	t.Logf("Prompt sent via send-keys: %q", testPrompt)

	// ── 9. Wait for Stop hook ─────────────────────────────────────────────────
	var ev stopEvent
	select {
	case ev = <-stopCh:
		t.Logf("Stop hook: stop_reason=%q transcript_path=%q", ev.StopReason, ev.TranscriptPath)
	case <-ctx.Done():
		t.Fatal("Timed out waiting for Claude Code Stop hook")
	}

	// Kill session so the FIFO writer closes and readerDone is signalled.
	exec.Command(tmuxBin, "kill-session", "-t", sessionName).Run() //nolint:errcheck
	select {
	case <-readerDone:
	case <-time.After(5 * time.Second):
		t.Log("Warning: FIFO reader did not drain within 5s")
	}
	fifoFile.Close()

	// ── 10. Write session file ────────────────────────────────────────────────
	outputMu.Lock()
	captured := append([]string(nil), outputLines...)
	outputMu.Unlock()

	sessionPath := writeSessionFile(t, testPrompt, ev.StopReason, captured)
	t.Logf("Session log: %s  (%d raw FIFO lines)", sessionPath, len(captured))

	// ── 11. Transcript assertions ─────────────────────────────────────────────
	if ev.TranscriptPath == "" {
		t.Fatal("transcript_path was not provided in the Stop hook payload")
	}

	// Claude Code fires the Stop hook while still finishing the transcript write
	// (visible as "Embellishing… (running stop hook)" in the TUI). Retry until
	// the assistant turn appears or the deadline is reached.
	var agentResponse string
	retryDeadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(retryDeadline) {
		agentResponse = agent.ExtractTranscriptResponse(ev.TranscriptPath)
		if agentResponse != "" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Logf("Agent response (from transcript): %q", agentResponse)

	if agentResponse == "" {
		// Log the raw transcript to help diagnose format mismatches.
		if raw, err := os.ReadFile(ev.TranscriptPath); err == nil {
			t.Logf("Raw transcript (%d bytes):\n%s", len(raw), raw)
		} else {
			t.Logf("Could not read transcript: %v", err)
		}
		t.Error("Agent response extracted from transcript is empty after 10s")
	}
	if agentResponse == testPrompt {
		t.Errorf("Agent response equals the input prompt %q — no distinct reply produced", testPrompt)
	}
}

// ── Types ─────────────────────────────────────────────────────────────────────

type stopEvent struct {
	StopReason     string
	TranscriptPath string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// writeTestHooks writes Stop and Notification HTTP hooks into
// workDir/.claude/settings.json, preserving all other existing keys.
// Returns a cleanup function that restores the original file content.
func writeTestHooks(t *testing.T, workDir string, port int) func() {
	t.Helper()
	claudeDir := filepath.Join(workDir, ".claude")
	if err := os.MkdirAll(claudeDir, 0755); err != nil {
		t.Fatalf("mkdir .claude: %v", err)
	}
	settingsPath := filepath.Join(claudeDir, "settings.json")

	// Save original so we can restore it on exit.
	originalData, _ := os.ReadFile(settingsPath)

	// Merge: preserve existing keys, overwrite only "hooks".
	existing := make(map[string]any)
	if originalData != nil {
		json.Unmarshal(originalData, &existing) //nolint:errcheck
	}
	existing["hooks"] = map[string]any{
		"Stop": []any{
			map[string]any{
				"matcher": "*",
				"hooks": []any{
					map[string]any{"type": "http", "url": fmt.Sprintf("http://localhost:%d/hooks/stop", port)},
				},
			},
		},
		"Notification": []any{
			map[string]any{
				"matcher": "*",
				"hooks": []any{
					map[string]any{"type": "http", "url": fmt.Sprintf("http://localhost:%d/hooks/notification", port)},
				},
			},
		},
	}
	data, err := json.MarshalIndent(existing, "", "  ")
	if err != nil {
		t.Fatalf("marshal hooks: %v", err)
	}
	if err := os.WriteFile(settingsPath, data, 0644); err != nil {
		t.Fatalf("write settings.json: %v", err)
	}

	return func() {
		if originalData != nil {
			os.WriteFile(settingsPath, originalData, 0644) //nolint:errcheck
		}
	}
}

func startTestHooksServer(t *testing.T, port int, onStop func(stopEvent), onNotif func(string)) *http.Server {
	t.Helper()
	mux := http.NewServeMux()

	mux.HandleFunc("/hooks/stop", func(w http.ResponseWriter, r *http.Request) {
		var p struct {
			StopReason     string `json:"stop_reason"`
			SessionID      string `json:"session_id"`
			TranscriptPath string `json:"transcript_path"`
		}
		json.NewDecoder(r.Body).Decode(&p) //nolint:errcheck
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok")) //nolint:errcheck
		onStop(stopEvent{StopReason: p.StopReason, TranscriptPath: p.TranscriptPath})
	})

	mux.HandleFunc("/hooks/notification", func(w http.ResponseWriter, r *http.Request) {
		var p struct{ Message string `json:"message"` }
		json.NewDecoder(r.Body).Decode(&p) //nolint:errcheck
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok")) //nolint:errcheck
		if onNotif != nil {
			onNotif(p.Message)
		}
	})

	srv := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", port), Handler: mux}
	go srv.ListenAndServe() //nolint:errcheck

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 100*time.Millisecond); err == nil {
			conn.Close()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	return srv
}

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

func writeSessionFile(t *testing.T, prompt, stopReason string, outputLines []string) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.TempDir()
	}
	logsDir := filepath.Join(home, ".tasksquad", "logs")
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		t.Fatalf("mkdir logs: %v", err)
	}
	sessionPath := filepath.Join(logsDir, fmt.Sprintf("test-session-%d.txt", time.Now().Unix()))

	var sb strings.Builder
	sb.WriteString("=== TaskSquad tmux Integration Test ===\n")
	sb.WriteString(fmt.Sprintf("Time:        %s\n", time.Now().Format(time.RFC3339)))
	sb.WriteString(fmt.Sprintf("Prompt:      %s\n", prompt))
	sb.WriteString(fmt.Sprintf("Stop reason: %s\n", stopReason))
	sb.WriteString(fmt.Sprintf("FIFO lines:  %d\n", len(outputLines)))
	sb.WriteString("\n--- RAW FIFO OUTPUT ---\n")
	for _, l := range outputLines {
		sb.WriteString(l)
		sb.WriteByte('\n')
	}
	sb.WriteString("\n=== END ===\n")

	if err := os.WriteFile(sessionPath, []byte(sb.String()), 0644); err != nil {
		t.Fatalf("write session file: %v", err)
	}
	return sessionPath
}

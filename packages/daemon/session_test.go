//go:build integration

package main_test

// Integration test: runs claude inside a real tmux session, streams output via
// tmux pipe-pane → FIFO (exactly as the daemon does), and asserts that:
//   - the Claude Code Stop hook fires and provides a transcript_path
//   - the transcript contains a non-empty assistant response
//   - the response is not equal to the input prompt
//
// Run with:
//
//	go test -v -tags integration -run TestClaudeCodeTmuxSession -timeout 120s ./...

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

	// ── 1. Work dir + hooks ───────────────────────────────────────────────────
	workDir := t.TempDir()
	t.Logf("Work dir: %s", workDir)

	port := freePort(t)
	t.Logf("Hooks port: %d", port)
	writeTestHooks(t, workDir, port)

	// ── 2. Hooks capture server ───────────────────────────────────────────────
	var (
		stopOnce sync.Once
		stopCh   = make(chan stopEvent, 1)
		notifCh  = make(chan string, 16)
	)
	srv := startTestHooksServer(t, port,
		func(ev stopEvent) { stopOnce.Do(func() { stopCh <- ev }) },
		func(msg string) {
			t.Logf("[notification] %s", msg)
			select {
			case notifCh <- msg:
			default:
			}
		},
	)
	defer srv.Shutdown(context.Background()) //nolint:errcheck

	// ── 3. FIFO for tmux pipe-pane output ─────────────────────────────────────
	fifoPath := filepath.Join(t.TempDir(), "output.fifo")
	if err := syscall.Mkfifo(fifoPath, 0644); err != nil {
		t.Fatalf("mkfifo: %v", err)
	}

	// ── 4. Start tmux session running claude (interactive, no -p flag) ────────
	sessionName := fmt.Sprintf("ts-test-%d", os.Getpid())
	env := filterEnv(os.Environ(), "CLAUDECODE") // prevent recursion

	// Run claude non-interactively with -p so the prompt is a CLI argument.
	// This avoids the "trust this folder" TUI dialog that appears when claude
	// starts in interactive mode inside an untrusted temp directory.
	// The tmux + pipe-pane + FIFO + Stop-hook path is identical to what the
	// daemon uses; only the prompt delivery method differs.
	newSessArgs := []string{
		"new-session", "-d", "-s", sessionName,
		"-c", workDir, "-x", "220", "-y", "50",
		"--", "claude", "-p", testPrompt,
	}
	newSessCmd := exec.Command(tmuxBin, newSessArgs...)
	newSessCmd.Env = env
	if out, err := newSessCmd.CombinedOutput(); err != nil {
		t.Fatalf("tmux new-session: %v: %s", err, out)
	}
	t.Logf("tmux session: %s  prompt: %q", sessionName, testPrompt)

	t.Cleanup(func() {
		exec.Command(tmuxBin, "kill-session", "-t", sessionName).Run() //nolint:errcheck
		os.Remove(fifoPath)
	})

	// ── 5. Open FIFO reader (blocks until pipe-pane opens write end) ──────────
	fifoCh := make(chan *os.File, 1)
	go func() {
		f, err := os.Open(fifoPath)
		if err != nil {
			t.Logf("FIFO open error: %v", err)
			return
		}
		fifoCh <- f
	}()

	// pipe-pane: sends all pane output to FIFO (opens write end → unblocks reader).
	// Run this immediately after new-session so no early output is missed.
	exec.Command(tmuxBin, "pipe-pane", "-t", sessionName, "cat > "+fifoPath).Run() //nolint:errcheck

	// ── 6. Wait for FIFO reader to be ready ───────────────────────────────────
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()

	var fifoFile *os.File
	select {
	case fifoFile = <-fifoCh:
		t.Logf("FIFO open — streaming output")
	case <-time.After(5 * time.Second):
		t.Fatal("FIFO open timed out")
	}

	// ── 7. Stream FIFO output ─────────────────────────────────────────────────
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

	// ── 8. Wait for Stop hook ─────────────────────────────────────────────────
	var ev stopEvent
	select {
	case ev = <-stopCh:
		t.Logf("Stop hook: stop_reason=%q transcript_path=%q", ev.StopReason, ev.TranscriptPath)

	case <-ctx.Done():
		t.Fatal("Timed out waiting for Claude Code Stop hook")
	}

	// Kill the tmux session so the FIFO writer (cat) closes → readerDone.
	exec.Command(tmuxBin, "kill-session", "-t", sessionName).Run() //nolint:errcheck
	select {
	case <-readerDone:
	case <-time.After(5 * time.Second):
		t.Log("Warning: FIFO reader did not drain within 5s")
	}
	fifoFile.Close()

	// ── 9. Write session file ────────────────────────────────────────────────
	outputMu.Lock()
	captured := append([]string(nil), outputLines...)
	outputMu.Unlock()

	sessionPath := writeSessionFile(t, testPrompt, ev.StopReason, captured)
	t.Logf("Session log: %s", sessionPath)
	t.Logf("Captured %d raw FIFO lines", len(captured))

	// ── 10. Transcript assertions ─────────────────────────────────────────────
	if ev.TranscriptPath == "" {
		t.Fatal("transcript_path was not provided in the Stop hook payload")
	}

	agentResponse := agent.ExtractTranscriptResponse(ev.TranscriptPath)
	t.Logf("Agent response (from transcript): %q", agentResponse)

	if agentResponse == "" {
		t.Error("Agent response extracted from transcript is empty")
	}
	if agentResponse == testPrompt {
		t.Errorf("Agent response equals the input prompt %q — no distinct reply produced", testPrompt)
	}
}

// ── stopEvent ─────────────────────────────────────────────────────────────────

// stopEvent carries the payload from the Claude Code Stop hook.
type stopEvent struct {
	StopReason     string
	TranscriptPath string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
							"type": "http",
							"url":  fmt.Sprintf("http://localhost:%d/hooks/stop", port),
						},
					},
				},
			},
			"Notification": []any{
				map[string]any{
					"matcher": "",
					"hooks": []any{
						map[string]any{
							"type": "http",
							"url":  fmt.Sprintf("http://localhost:%d/hooks/notification", port),
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
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 100*time.Millisecond)
		if err == nil {
			conn.Close()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	return srv
}

// writeSessionFile writes captured output to ~/.tasksquad/logs/test-session-<unix>.txt.
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

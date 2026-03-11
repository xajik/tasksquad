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
//	go test -v -tags integration -run TestClaudeCodeTmuxSession -timeout 20s ./...
//	go test -v -tags integration -run TestGeminiTmuxSession -timeout 20s ./...
//	go test -v -tags integration -run TestOpenCodeTmuxSession -timeout 20s ./...
//
// NOTE: the test temporarily overwrites .claude/settings.json hooks in the
// project root and restores them on exit. Do not run it while the daemon is
// actively handling tasks in the same directory.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
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

func TestOpenCodeTmuxSession(t *testing.T) {
	runTmuxIntegrationTest(t, "opencode", "opencode")
}

func TestGeminiTmuxSession(t *testing.T) {
	runTmuxIntegrationTest(t, "gemini", "gemini")
}

func TestClaudeCodeTmuxSession(t *testing.T) {
	runTmuxIntegrationTest(t, "claude", "claude")
}

func runTmuxIntegrationTest(t *testing.T, provider, binName string) {
	// ── 0. Prerequisites ──────────────────────────────────────────────────────
	tmuxBin, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not found on PATH — skipping")
	}
	if _, err := exec.LookPath(binName); err != nil {
		t.Skipf("%s not found on PATH — skipping", binName)
	}

	// ── 1. Work dir: project root (already trusted) ───────────────────────────
	daemonDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd: %v", err)
	}
	workDir, err := filepath.Abs(filepath.Join(daemonDir, "..", ".."))
	if err != nil {
		t.Fatalf("filepath.Abs: %v", err)
	}
	t.Logf("[%s] Work dir: %s", provider, workDir)

	// ── 2. Hooks: overwrite only the hooks key, restore on exit ───────────────
	port := freePort(t)
	t.Logf("[%s] Hooks port: %d", provider, port)
	t.Cleanup(writeTestHooks(t, workDir, port, provider))

	// ── 3. Hooks capture server ───────────────────────────────────────────────
	var (
		stopOnce sync.Once
		stopCh   = make(chan stopEvent, 1)
	)
	srv := startTestHooksServer(t, port, provider,
		func(ev stopEvent) { stopOnce.Do(func() { stopCh <- ev }) },
		func(msg string) { t.Logf("[%s notification] %s", provider, msg) },
	)
	defer srv.Shutdown(context.Background()) //nolint:errcheck

	// ── 4. FIFO ───────────────────────────────────────────────────────────────
	fifoPath := filepath.Join(t.TempDir(), "output.fifo")
	if err := syscall.Mkfifo(fifoPath, 0644); err != nil {
		t.Fatalf("mkfifo: %v", err)
	}

	// ── 5. Start tmux session running CLI in interactive mode ─────────────────
	sessionName := fmt.Sprintf("ts-test-%s-%d", provider, os.Getpid())
	env := filterEnv(os.Environ(), "CLAUDECODE", "GEMINI")
	if provider == "gemini" {
		env = append(env, "GEMINI_TRUST_WORKSPACE=1")
	}

	newSessArgs := []string{
		"new-session", "-d", "-s", sessionName,
		"-c", workDir, "-x", "220", "-y", "50",
		"--", binName,
	}

	newSessCmd := exec.Command(tmuxBin, newSessArgs...)
	newSessCmd.Env = env
	if out, err := newSessCmd.CombinedOutput(); err != nil {
		t.Fatalf("tmux new-session: %v: %s", err, out)
	}
	t.Logf("[%s] tmux session started: %s", provider, sessionName)

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
		t.Logf("[%s] FIFO open — streaming output", provider)
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
			t.Logf("[%s fifo] %s", provider, line)
		}
	}()

	// ── 8. Wait for interactive prompt, then send the task ────────────────────
	// Give the TUI time to finish rendering its startup screen.
	time.Sleep(3 * time.Second)
	exec.Command(tmuxBin, "send-keys", "-t", sessionName, testPrompt).Run() //nolint:errcheck
	time.Sleep(500 * time.Millisecond)
	exec.Command(tmuxBin, "send-keys", "-t", sessionName, "Enter").Run() //nolint:errcheck
	t.Logf("[%s] Prompt sent via send-keys: %q", provider, testPrompt)

	// ── 9. Wait for Stop/SessionEnd hook ──────────────────────────────────────
	var ev stopEvent
	select {
	case ev = <-stopCh:
		t.Logf("[%s] Stop hook: stop_reason=%q transcript_path=%q", provider, ev.StopReason, ev.TranscriptPath)
	case <-ctx.Done():
		t.Fatalf("Timed out waiting for %s hook", provider)
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

	sessionPath := writeSessionFile(t, provider, testPrompt, ev.StopReason, captured)
	t.Logf("[%s] Session log: %s  (%d raw FIFO lines)", provider, sessionPath, len(captured))

	// ── 11. Transcript assertions ─────────────────────────────────────────────
	if ev.TranscriptPath == "" {
		t.Fatal("transcript_path was not provided in the hook payload")
	}

	// Retry until the assistant turn appears or the deadline is reached.
	var agentResponse string
	retryDeadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(retryDeadline) {
		agentResponse = agent.ExtractTranscriptResponse(ev.TranscriptPath)
		if agentResponse != "" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Logf("[%s] Agent response (from transcript): %q", provider, agentResponse)

	if agentResponse == "" {
		// Log the raw transcript to help diagnose format mismatches.
		if raw, err := os.ReadFile(ev.TranscriptPath); err == nil {
			t.Logf("[%s] Raw transcript (%d bytes):\n%s", provider, len(raw), raw)
		} else {
			t.Logf("[%s] Could not read transcript: %v", provider, err)
		}
		t.Errorf("[%s] Agent response extracted from transcript is empty after 10s", provider)
	}
	if agentResponse == testPrompt {
		t.Errorf("[%s] Agent response equals the input prompt %q — no distinct reply produced", provider, testPrompt)
	}
}

// ── Types ─────────────────────────────────────────────────────────────────────

type stopEvent struct {
	StopReason     string
	TranscriptPath string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func writeTestHooks(t *testing.T, workDir string, port int, provider string) func() {
	t.Helper()

	var dotDir, settingsPath string
	if provider == "gemini" {
		dotDir = filepath.Join(workDir, ".gemini")
		settingsPath = filepath.Join(dotDir, "settings.json")
	} else if provider == "opencode" {
		dotDir = filepath.Join(workDir, ".opencode", "plugins")
		settingsPath = filepath.Join(dotDir, "tasksquad.mjs")
	} else {
		dotDir = filepath.Join(workDir, ".claude")
		settingsPath = filepath.Join(dotDir, "settings.json")
	}

	if err := os.MkdirAll(dotDir, 0755); err != nil {
		t.Fatalf("mkdir %s: %v", dotDir, err)
	}

	// Save original so we can restore it on exit.
	originalData, _ := os.ReadFile(settingsPath)

	if provider == "opencode" {
		plugin := fmt.Sprintf(`// Auto-generated by tsq test — do not edit
import { type Plugin } from "@opencode-ai/plugin";
import { writeFileSync } from "node:fs"
import { join } from "node:path"

export const TaskSquadPlugin: Plugin = async ({ client }) => {
  await client.app.log({ body: { service: "tasksquad", level: "info", message: "Plugin initializing" } })

  const post = async (path, body) => {
    await client.app.log({ body: { service: "tasksquad", level: "debug", message: "POST " + path, data: body } })
    try {
      const resp = await fetch("http://localhost:%d" + path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      })
      await client.app.log({ body: { service: "tasksquad", level: "debug", message: "POST response: " + resp.status } })
    } catch (e) {
      await client.app.log({ body: { service: "tasksquad", level: "error", message: "hook error: " + e.message } })
    }
  }

  const transcriptFile = join("/tmp", "tsq-test-oc-%%d.json")
  let lastTranscriptPath = ""
  let lastMessage = ""

  const extractText = (message) => {
    if (typeof message.content === "string") return message.content
    if (Array.isArray(message.content)) {
      return message.content.filter(p => p.type === "text").map(p => p.text || "").join("")
    }
    return ""
  }

  return {
    // This hook triggers for every message in the chat
    "chat.message": async ({}, { message }) => {
      await client.app.log({ body: { service: "tasksquad", level: "debug", message: "chat.message, role: " + message.role } })
      
      if (message.role === "assistant") {
        const text = extractText(message)
        lastMessage = text || ""
        await client.app.log({ body: { service: "tasksquad", level: "info", message: "assistant: " + (text?.slice(0, 50) || "empty") } })

        if (text) {
          try {
            writeFileSync(transcriptFile,
              JSON.stringify({ messages: [{ type: "assistant", content: text }] }))
            lastTranscriptPath = transcriptFile
            await client.app.log({ body: { service: "tasksquad", level: "info", message: "wrote transcript: " + transcriptFile } })
          } catch (e) {
            await client.app.log({ body: { service: "tasksquad", level: "error", message: "write error: " + e.message } })
          }
        }

        await post("/hooks/notification", { message: lastMessage, transcript_path: lastTranscriptPath })
      }

      if (message.role === "user") {
        await client.app.log({ body: { service: "tasksquad", level: "debug", message: "user message received" } })
      }
    },

    "session.idle": async ({}) => {
      await client.app.log({ body: { service: "tasksquad", level: "info", message: "session.idle - sending stop" } })
      await post("/hooks/stop", { stop_reason: "idle", transcript_path: lastTranscriptPath, message: lastMessage })
    },

    "session.error": async ({ error }) => {
      await client.app.log({ body: { service: "tasksquad", level: "info", message: "session.error: " + error?.message } })
      await post("/hooks/stop", { stop_reason: "error", message: error?.message, transcript_path: lastTranscriptPath })
    },

    "session.created": async ({}) => {
      await client.app.log({ body: { service: "tasksquad", level: "info", message: "session.created" } })
    },
  }
}
`, port)
		if err := os.WriteFile(settingsPath, []byte(plugin), 0644); err != nil {
			t.Fatalf("write opencode plugin: %v", err)
		}
		t.Logf("[%s] Wrote plugin to %s (%d bytes)", provider, settingsPath, len(plugin))
	} else {
		// Merge: preserve existing keys, overwrite only "hooks".
		existing := make(map[string]any)
		if originalData != nil {
			json.Unmarshal(originalData, &existing) //nolint:errcheck
		}

		if provider == "gemini" {
			stopURL := fmt.Sprintf("http://localhost:%d/hooks/stop", port)
			notifURL := fmt.Sprintf("http://localhost:%d/hooks/notification", port)
			existing["hooks"] = map[string]any{
				"SessionEnd": []any{
					map[string]any{
						"name":    "tasksquad-stop",
						"type":    "command",
						"command": fmt.Sprintf(`curl -s -X POST "%s" -H "Content-Type: application/json" -d @- > /dev/null 2>&1; printf '{}'`, stopURL),
						"timeout": 5000,
					},
				},
				"Notification": []any{
					map[string]any{
						"name":    "tasksquad-notif",
						"type":    "command",
						"command": fmt.Sprintf(`curl -s -X POST "%s" -H "Content-Type: application/json" -d @- > /dev/null 2>&1; printf '{}'`, notifURL),
						"timeout": 5000,
					},
				},
			}
		} else {
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
		}

		data, err := json.MarshalIndent(existing, "", "  ")
		if err != nil {
			t.Fatalf("marshal hooks: %v", err)
		}
		if err := os.WriteFile(settingsPath, data, 0644); err != nil {
			t.Fatalf("write settings.json: %v", err)
		}
	}

	return func() {
		if originalData != nil {
			os.WriteFile(settingsPath, originalData, 0644) //nolint:errcheck
		} else {
			os.Remove(settingsPath)
		}
	}
}

func startTestHooksServer(t *testing.T, port int, provider string, onStop func(stopEvent), onNotif func(string)) *http.Server {
	t.Helper()
	mux := http.NewServeMux()

	mux.HandleFunc("/hooks/stop", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)

		var transcriptPath string
		var stopReason string

		if provider == "gemini" {
			var p struct {
				Reason         string `json:"reason"`
				TranscriptPath string `json:"transcript_path"`
			}
			json.Unmarshal(body, &p) //nolint:errcheck
			transcriptPath = p.TranscriptPath
			stopReason = p.Reason
		} else {
			var p struct {
				StopReason     string `json:"stop_reason"`
				TranscriptPath string `json:"transcript_path"`
			}
			json.Unmarshal(body, &p) //nolint:errcheck
			transcriptPath = p.TranscriptPath
			stopReason = p.StopReason
		}

		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok")) //nolint:errcheck
		onStop(stopEvent{StopReason: stopReason, TranscriptPath: transcriptPath})
	})

	mux.HandleFunc("/hooks/notification", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var msg string

		if provider == "gemini" {
			var p struct {
				Message string `json:"message"`
			}
			json.Unmarshal(body, &p) //nolint:errcheck
			msg = p.Message
		} else {
			var p struct {
				Message string `json:"message"`
			}
			json.Unmarshal(body, &p) //nolint:errcheck
			msg = p.Message
		}

		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok")) //nolint:errcheck
		if onNotif != nil {
			onNotif(msg)
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

func writeSessionFile(t *testing.T, provider, prompt, stopReason string, outputLines []string) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.TempDir()
	}
	logsDir := filepath.Join(home, ".tasksquad", "logs")
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		t.Fatalf("mkdir logs: %v", err)
	}
	sessionPath := filepath.Join(logsDir, fmt.Sprintf("test-session-%s-%d.txt", provider, time.Now().Unix()))

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("=== TaskSquad tmux Integration Test (%s) ===\n", provider))
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

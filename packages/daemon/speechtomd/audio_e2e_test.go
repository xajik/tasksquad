//go:build integration

package speechtomd

// Audio end-to-end integration tests.
//
// Requirements:
//   - ffmpeg in PATH              (brew install ffmpeg)
//   - whisper-cli in PATH         (brew install whisper-cpp)
//   - At least one Whisper model  (any size, smallest available is used)
//   - ../speech-test.mp3          (file in the daemon package directory)
//
// Run with:
//
//	go test -tags integration -v -run TestAudioE2E -timeout 5m ./speechtomd/...

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tasksquad/daemon/whisperer"
)

const (
	audioTestFile = "../speech-test.mp3"
	chunkSec      = 15 // seconds per recording cycle
)

// ── prereqs & audio helpers ───────────────────────────────────────────────

// findSmallestModel returns the ModelSize string of the smallest downloaded
// Whisper model, skipping the test if none are present.
func findSmallestModel(t *testing.T) string {
	t.Helper()
	for _, size := range whisperer.AllSizes {
		if _, err := whisperer.ModelPath(size); err == nil {
			t.Logf("[prereqs] using whisper model: %s", size)
			return string(size)
		}
	}
	t.Skip("no whisper model downloaded — use the UI to download at least one")
	return ""
}

func checkAudioPrereqs(t *testing.T) {
	t.Helper()
	if issues := whisperer.CheckPrereqs(); len(issues) > 0 {
		msgs := make([]string, 0, len(issues))
		for k, v := range issues {
			msgs = append(msgs, fmt.Sprintf("%s: %s", k, v))
		}
		t.Skipf("prerequisites missing: %s", strings.Join(msgs, "; "))
	}
	if _, err := os.Stat(audioTestFile); err != nil {
		t.Skipf("test audio file not found at %s", audioTestFile)
	}
}

// checkOmlxAvailable skips t if the omlx server is not reachable or has no models loaded.
// Returns the first available model name.
func checkOmlxAvailable(t *testing.T) string {
	t.Helper()
	models, err := ListLocalModels("")
	if err != nil {
		t.Skipf("omlx server not available at %s: %v", omlxBaseURL, err)
	}
	if len(models) == 0 {
		t.Skip("omlx server running but no models loaded")
	}
	t.Logf("[prereqs] omlx available, using model: %s", models[0])
	return models[0]
}

// extractChunk uses ffmpeg to cut [startSec, startSec+durSec) from the MP3
// and returns the resulting bytes.
func extractChunk(t *testing.T, startSec, durSec int) []byte {
	t.Helper()
	out := filepath.Join(t.TempDir(), fmt.Sprintf("chunk_%d.mp3", startSec))
	cmd := exec.Command("ffmpeg", "-y",
		"-ss", fmt.Sprintf("%d", startSec),
		"-t", fmt.Sprintf("%d", durSec),
		"-i", audioTestFile,
		"-c", "copy",
		out,
	)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg extract [%d..%d]: %v\n%s", startSec, startSec+durSec, err, output)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read chunk: %v", err)
	}
	t.Logf("[audio] extracted chunk %d–%d s (%d bytes)", startSec, startSec+durSec, len(data))
	return data
}

// sendChunk pushes audio bytes through ReceiveAudioChunk (real Whisper STT)
// and returns the additional transcript text appended by this call.
func sendChunk(t *testing.T, mgr *Manager, audioBytes []byte, modelSize, label string) string {
	t.Helper()
	txBefore := mgr.Transcript()
	if err := mgr.ReceiveAudioChunk(modelSize, audioBytes); err != nil {
		t.Logf("[%s] ReceiveAudioChunk: %v", label, err)
	}
	added := strings.TrimPrefix(mgr.Transcript(), txBefore)
	t.Logf("[%s] STT → %q", label, strings.TrimSpace(added))
	return strings.TrimSpace(added)
}

// ── stub hook agent ───────────────────────────────────────────────────────

// stubHookAgent implements ChunkAgent, simulating the async hook-delivery
// pattern of tmuxAgent (and by extension, the Claude Code CLI path) without
// actually spawning tmux or a real AI agent.
type stubHookAgent struct {
	mu       sync.Mutex
	pending  chan string
	stopCh   chan struct{}
	stopOnce sync.Once
}

func newStubHookAgent() *stubHookAgent {
	return &stubHookAgent{stopCh: make(chan struct{})}
}

func (s *stubHookAgent) Start() error { return nil }
func (s *stubHookAgent) Stop() {
	s.stopOnce.Do(func() { close(s.stopCh) })
}

// Complete blocks until Deliver is called (or timeout/stop). This mirrors
// tmuxAgent.Complete which blocks on a channel until the hook callback fires.
func (s *stubHookAgent) Complete(_, _ string, _ bool) (string, error) {
	ch := make(chan string, 1)
	s.mu.Lock()
	s.pending = ch
	s.mu.Unlock()

	t := time.NewTimer(10 * time.Second)
	defer t.Stop()
	select {
	case result := <-ch:
		return result, nil
	case <-t.C:
		return "", errAgentTimeout
	case <-s.stopCh:
		return "", fmt.Errorf("agent stopped")
	}
}

// Deliver unblocks the in-flight Complete call, as if a hook callback arrived.
func (s *stubHookAgent) Deliver(result string) {
	s.mu.Lock()
	ch := s.pending
	s.pending = nil
	s.mu.Unlock()
	if ch != nil {
		ch <- result
	}
}

// pendingReady returns true once Complete has been entered and is waiting.
func (s *stubHookAgent) pendingReady(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		p := s.pending
		s.mu.Unlock()
		if p != nil {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

// ── manager setup ─────────────────────────────────────────────────────────

// setupManagerWithAgent creates a Manager with the given agent pre-wired in
// StateReady state, bypassing the normal StartSession/StartLocalSession flow.
func setupManagerWithAgent(t *testing.T, agent ChunkAgent) *Manager {
	t.Helper()
	mgr := newMgr()
	sess, err := NewSession("stub", "base")
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(sess.DirPath) })

	mgr.mu.Lock()
	mgr.session = sess
	mgr.session.State = StateReady
	mgr.queue = NewChunkQueue()
	mgr.agent = agent
	mgr.mu.Unlock()

	return mgr
}

// ── tests ─────────────────────────────────────────────────────────────────

// TestAudioE2E_LocalModel exercises the full pipeline end-to-end with real
// Whisper STT and the real local omlx model (no mocks). Skips if omlx is not
// running at localhost:8000.
//
// Flow per cycle: Start recording → send MP3 bytes → real STT → queue →
// pause (triggers flush) → real omlx HTTP request → markdown written.
func TestAudioE2E_LocalModel(t *testing.T) {
	checkAudioPrereqs(t)
	whisperModel := findSmallestModel(t)
	omlxModel := checkOmlxAvailable(t)

	chunk1 := extractChunk(t, 0, chunkSec)
	chunk2 := extractChunk(t, chunkSec, chunkSec)

	mgr := newMgr()
	if err := mgr.StartLocalSession(omlxModel, whisperModel, ""); err != nil {
		t.Fatalf("StartLocalSession: %v", err)
	}
	cleanupSessionDir(t, mgr)
	defer mgr.StopSession()
	waitState(t, mgr, "ready", 10*time.Second)

	var totalTranscript string

	for cycle, audio := range [][]byte{chunk1, chunk2} {
		cycleN := cycle + 1
		t.Logf("──── cycle %d ────", cycleN)

		if err := mgr.StartRecording(false); err != nil {
			t.Fatalf("cycle %d: StartRecording: %v", cycleN, err)
		}

		text := sendChunk(t, mgr, audio, whisperModel, fmt.Sprintf("cycle %d", cycleN))
		totalTranscript += text

		if err := mgr.PauseRecording(); err != nil {
			t.Fatalf("cycle %d: PauseRecording: %v", cycleN, err)
		}

		if text != "" {
			mdBefore := mgr.Markdown()
			t.Logf("cycle %d: waiting for real omlx response...", cycleN)
			if !waitCond(t, 3*time.Minute, func() bool {
				return mgr.Markdown() != mdBefore
			}) {
				t.Errorf("cycle %d: markdown not updated within 3 min; transcript: %q", cycleN, text)
			} else {
				t.Logf("cycle %d: markdown updated ✓ (%d chars)", cycleN, len(mgr.Markdown()))
			}
		} else {
			t.Logf("cycle %d: blank/silent audio — no agent call expected", cycleN)
		}
	}

	if totalTranscript == "" {
		t.Error("both cycles produced empty transcripts — check the MP3 contains audible speech")
	}
	t.Logf("final transcript: %q", mgr.Transcript())
	t.Logf("final markdown:\n%s", mgr.Markdown())
}

// TestAudioE2E_HookAgent exercises the full pipeline with real Whisper STT
// and a stub ChunkAgent that simulates the async hook-delivery pattern used
// by the tmuxAgent (Claude Code CLI) path.
//
// Flow per cycle: Start recording → send MP3 bytes → STT → queue →
// pause (triggers flush) → stub.Complete blocks → Deliver unblocks it →
// markdown written.
func TestAudioE2E_HookAgent(t *testing.T) {
	checkAudioPrereqs(t)
	modelSize := findSmallestModel(t)

	chunk1 := extractChunk(t, 0, chunkSec)
	chunk2 := extractChunk(t, chunkSec, chunkSec)

	stub := newStubHookAgent()
	mgr := setupManagerWithAgent(t, stub)
	defer mgr.StopSession()

	var totalTranscript string

	for cycle, audio := range [][]byte{chunk1, chunk2} {
		cycleN := cycle + 1
		t.Logf("──── cycle %d ────", cycleN)

		if err := mgr.StartRecording(false); err != nil {
			t.Fatalf("cycle %d: StartRecording: %v", cycleN, err)
		}

		text := sendChunk(t, mgr, audio, modelSize, fmt.Sprintf("cycle %d", cycleN))
		totalTranscript += text

		// PauseRecording flushes the queue; dispatchChunk starts a goroutine
		// that blocks inside stub.Complete, waiting for Deliver.
		if err := mgr.PauseRecording(); err != nil {
			t.Fatalf("cycle %d: PauseRecording: %v", cycleN, err)
		}

		if text != "" {
			// Wait for the dispatch goroutine to enter Complete and set pending.
			if !stub.pendingReady(5 * time.Second) {
				t.Fatalf("cycle %d: stub.Complete not entered within 5s after PauseRecording", cycleN)
			}
			mdResponse := fmt.Sprintf("# Notes\n\nCycle %d: %s", cycleN, text)
			stub.Deliver(mdResponse)
			t.Logf("cycle %d: delivered %d-char response to stub agent", cycleN, len(mdResponse))

			if !waitCond(t, 5*time.Second, func() bool {
				return strings.Contains(mgr.Markdown(), fmt.Sprintf("Cycle %d", cycleN))
			}) {
				t.Errorf("cycle %d: markdown not updated; got: %q", cycleN, mgr.Markdown())
			} else {
				t.Logf("cycle %d: markdown updated ✓", cycleN)
			}
		} else {
			t.Logf("cycle %d: blank/silent audio — skipping agent delivery", cycleN)
		}
	}

	if totalTranscript == "" {
		t.Error("both cycles produced empty transcripts — check the MP3 contains audible speech")
	}
	t.Logf("final transcript: %q", mgr.Transcript())
	t.Logf("final markdown:   %q", mgr.Markdown())
}

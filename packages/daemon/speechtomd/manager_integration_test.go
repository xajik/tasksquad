package speechtomd

// Integration tests for Manager + localModelAgent.
// They run a real httptest.Server that simulates omlx, exercise the full
// pipeline (StartLocalSession → StartRecording → enqueue/flush → HTTP call →
// handleAgentResult → markdown file), and verify SSE events.
//
// No real audio or whisper is required — text is injected via queue.Enqueue
// and the flush is triggered manually, matching exactly what ReceiveAudioChunk
// does after transcription.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tasksquad/daemon/config"
)

// ── helpers ──────────────────────────────────────────────────────────────────

// waitState polls mgr.Status()["state"] until it equals want or timeout elapses.
func waitState(t *testing.T, mgr *Manager, want string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if s, _ := mgr.Status()["state"].(string); s == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	got, _ := mgr.Status()["state"].(string)
	t.Fatalf("state %q not reached within %s (current: %q)", want, timeout, got)
}

// waitCond polls cond() until true or timeout.
func waitCond(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

// omlxFixture is a controllable mock omlx server.
type omlxFixture struct {
	srv      *httptest.Server
	requests chan capturedRequest // one entry per /v1/chat/completions call
}

type capturedRequest struct {
	body    map[string]any
	release chan string // close or send to unblock the handler
}

// newOmlxFixture creates a mock omlx server and overrides omlxBaseURL.
// modelIDs is the list returned by /v1/models.
// t.Cleanup restores the original URL and closes the server.
func newOmlxFixture(t *testing.T, modelIDs []string) *omlxFixture {
	t.Helper()
	f := &omlxFixture{
		requests: make(chan capturedRequest, 32),
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/models":
			data := make([]map[string]string, len(modelIDs))
			for i, id := range modelIDs {
				data[i] = map[string]string{"id": id}
			}
			json.NewEncoder(w).Encode(map[string]any{"data": data}) //nolint:errcheck
		case "/v1/chat/completions":
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
			rel := make(chan string, 1)
			f.requests <- capturedRequest{body: body, release: rel}
			content := <-rel // blocks until test sends a response
			json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
				"choices": []map[string]any{
					{"message": map[string]string{"content": content, "role": "assistant"}},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))

	prev := omlxBaseURL
	omlxBaseURL = f.srv.URL
	t.Cleanup(func() {
		omlxBaseURL = prev
		f.srv.Close()
	})
	return f
}

// respond sends a response to the oldest in-flight chat/completions request.
// It blocks until a request arrives (up to timeout) then unblocks the handler.
func (f *omlxFixture) respond(t *testing.T, content string, timeout time.Duration) capturedRequest {
	t.Helper()
	select {
	case req := <-f.requests:
		req.release <- content
		return req
	case <-time.After(timeout):
		t.Fatalf("timed out waiting for omlx request after %s", timeout)
		return capturedRequest{}
	}
}

// newMgr creates a Manager with an empty config (only needed for tmux agents).
func newMgr() *Manager { return New(&config.Config{}) }

// startReady starts a local session and waits for StateReady.
func startReady(t *testing.T, mgr *Manager, model string) {
	t.Helper()
	if err := mgr.StartLocalSession(model, "base", ""); err != nil {
		t.Fatalf("StartLocalSession: %v", err)
	}
	waitState(t, mgr, "ready", 3*time.Second)
}

// cleanupSessionDir registers t.Cleanup to remove the session directory.
func cleanupSessionDir(t *testing.T, mgr *Manager) {
	t.Helper()
	mgr.mu.Lock()
	var dir string
	if mgr.session != nil {
		dir = mgr.session.DirPath
	}
	mgr.mu.Unlock()
	if dir != "" {
		t.Cleanup(func() { os.RemoveAll(dir) })
	}
}

// ── tests ─────────────────────────────────────────────────────────────────────

func TestIntegration_StartLocalSession_BecomesReady(t *testing.T) {
	f := newOmlxFixture(t, []string{"test-model"})
	_ = f
	mgr := newMgr()

	if err := mgr.StartLocalSession("test-model", "base", ""); err != nil {
		t.Fatalf("StartLocalSession: %v", err)
	}
	cleanupSessionDir(t, mgr)
	defer mgr.StopSession()

	waitState(t, mgr, "ready", 3*time.Second)

	status := mgr.Status()
	if status["state"] != "ready" {
		t.Errorf("expected state 'ready', got %v", status["state"])
	}
	if status["agent"] != "local" {
		t.Errorf("expected agent 'local', got %v", status["agent"])
	}
}

func TestIntegration_StartLocalSession_AutoSelectsModel(t *testing.T) {
	f := newOmlxFixture(t, []string{"first-model", "second-model"})
	_ = f
	mgr := newMgr()

	// Empty model name → should auto-select first from /v1/models.
	if err := mgr.StartLocalSession("", "base", ""); err != nil {
		t.Fatalf("StartLocalSession: %v", err)
	}
	cleanupSessionDir(t, mgr)
	defer mgr.StopSession()

	waitState(t, mgr, "ready", 3*time.Second)

	mgr.mu.Lock()
	la, _ := mgr.agent.(*localModelAgent)
	mgr.mu.Unlock()
	if la == nil {
		t.Fatal("expected agent to be a *localModelAgent")
	}
	if la.model != "first-model" {
		t.Errorf("expected auto-selected 'first-model', got %q", la.model)
	}
}

func TestIntegration_OmlxUnavailable_SessionStops(t *testing.T) {
	// Point at a port where nothing is listening.
	prev := omlxBaseURL
	omlxBaseURL = "http://127.0.0.1:19997"
	t.Cleanup(func() { omlxBaseURL = prev })

	mgr := newMgr()
	if err := mgr.StartLocalSession("m", "base", ""); err != nil {
		t.Fatalf("StartLocalSession: %v", err)
	}
	cleanupSessionDir(t, mgr)
	defer mgr.StopSession()

	waitState(t, mgr, "stopped", 3*time.Second)
}

func TestIntegration_Flush_WritesMarkdown(t *testing.T) {
	f := newOmlxFixture(t, []string{"m"})
	mgr := newMgr()
	startReady(t, mgr, "m")
	cleanupSessionDir(t, mgr)
	defer mgr.StopSession()

	if err := mgr.StartRecording(false); err != nil {
		t.Fatalf("StartRecording: %v", err)
	}

	mgr.queue.Enqueue("spoken words here", false)
	mgr.flushToAgent()

	req := f.respond(t, "# Title\n\nBody text.", 3*time.Second)
	_ = req

	if !waitCond(t, 3*time.Second, func() bool {
		return strings.Contains(mgr.Markdown(), "# Title")
	}) {
		t.Fatalf("markdown not written; got %q", mgr.Markdown())
	}
}

func TestIntegration_Flush_XMLFormatSentToModel(t *testing.T) {
	f := newOmlxFixture(t, []string{"m"})
	mgr := newMgr()
	startReady(t, mgr, "m")
	cleanupSessionDir(t, mgr)
	defer mgr.StopSession()

	mgr.StartRecording(false) //nolint:errcheck

	mgr.queue.Enqueue("my spoken text", false)
	mgr.flushToAgent()

	req := f.respond(t, "result", 3*time.Second)

	msgs, _ := req.body["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	userMsg, _ := msgs[1].(map[string]any)
	content, _ := userMsg["content"].(string)

	for _, tag := range []string{"<current_markdown>", "<new_transcript>", "<mode>append</mode>"} {
		if !strings.Contains(content, tag) {
			t.Errorf("user message missing %q\ngot: %s", tag, content)
		}
	}
	if !strings.Contains(content, "my spoken text") {
		t.Errorf("user message missing transcript text\ngot: %s", content)
	}
}

func TestIntegration_Flush_EditModeXML(t *testing.T) {
	f := newOmlxFixture(t, []string{"m"})
	mgr := newMgr()
	startReady(t, mgr, "m")
	cleanupSessionDir(t, mgr)
	defer mgr.StopSession()

	mgr.StartRecording(true) //nolint:errcheck

	mgr.queue.Enqueue("change title to Foo", true)
	mgr.flushToAgent()

	req := f.respond(t, "# Foo", 3*time.Second)

	msgs, _ := req.body["messages"].([]any)
	userMsg, _ := msgs[1].(map[string]any)
	content, _ := userMsg["content"].(string)

	if !strings.Contains(content, "<mode>edit</mode>") {
		t.Errorf("expected <mode>edit</mode> in user content\ngot: %s", content)
	}
}

func TestIntegration_Flush_CurrentMarkdownPassedToModel(t *testing.T) {
	f := newOmlxFixture(t, []string{"m"})
	mgr := newMgr()
	startReady(t, mgr, "m")
	cleanupSessionDir(t, mgr)
	defer mgr.StopSession()

	// Seed existing markdown.
	mgr.mu.Lock()
	if mgr.session != nil {
		mgr.session.WriteMarkdown("## Existing Content") //nolint:errcheck
	}
	mgr.mu.Unlock()

	mgr.StartRecording(false) //nolint:errcheck
	mgr.queue.Enqueue("new stuff", false)
	mgr.flushToAgent()

	req := f.respond(t, "## Existing Content\n\nnew stuff", 3*time.Second)

	msgs, _ := req.body["messages"].([]any)
	userMsg, _ := msgs[1].(map[string]any)
	content, _ := userMsg["content"].(string)

	if !strings.Contains(content, "Existing Content") {
		t.Errorf("current markdown not included in request\ngot: %s", content)
	}
}

func TestIntegration_BatchChaining_SecondBatchDispatchedAfterFirst(t *testing.T) {
	f := newOmlxFixture(t, []string{"m"})
	mgr := newMgr()
	startReady(t, mgr, "m")
	cleanupSessionDir(t, mgr)
	defer mgr.StopSession()

	mgr.StartRecording(false) //nolint:errcheck

	// Enqueue + flush first batch; the goroutine is now blocked waiting for f.respond.
	mgr.queue.Enqueue("first text", false)
	mgr.flushToAgent()

	// Wait until the request is in-flight (captured in f.requests channel).
	var firstReq capturedRequest
	select {
	case firstReq = <-f.requests:
	case <-time.After(3 * time.Second):
		t.Fatal("first request not received")
	}

	// Enqueue second batch while first is still in-flight (processing=true).
	mgr.queue.Enqueue("second text", false)

	// Release first response.
	firstReq.release <- "first result"

	// Wait for second batch to be dispatched and processed.
	secondReq := f.respond(t, "second result", 3*time.Second)
	_ = secondReq

	// Final markdown should be the second response.
	if !waitCond(t, 3*time.Second, func() bool {
		return mgr.Markdown() == "second result"
	}) {
		t.Errorf("expected final markdown 'second result', got %q", mgr.Markdown())
	}
}

func TestIntegration_ModelError_AgentStatusReturnsIdle(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/models":
			json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"id": "m"}}}) //nolint:errcheck
		case "/v1/chat/completions":
			http.Error(w, "overloaded", http.StatusServiceUnavailable)
		}
	}))
	prev := omlxBaseURL
	omlxBaseURL = srv.URL
	t.Cleanup(func() { omlxBaseURL = prev; srv.Close() })

	mgr := newMgr()
	startReady(t, mgr, "m")
	cleanupSessionDir(t, mgr)
	defer mgr.StopSession()

	mgr.StartRecording(false) //nolint:errcheck
	mgr.queue.Enqueue("text", false)
	mgr.flushToAgent()

	// After the model error, queue.processing must be reset so future flushes work.
	if !waitCond(t, 3*time.Second, func() bool {
		mgr.queue.mu.Lock()
		defer mgr.queue.mu.Unlock()
		return !mgr.queue.processing
	}) {
		t.Error("queue.processing not reset after model error")
	}
}

func TestIntegration_StopSession_ClearsState(t *testing.T) {
	f := newOmlxFixture(t, []string{"m"})
	_ = f
	mgr := newMgr()
	startReady(t, mgr, "m")
	cleanupSessionDir(t, mgr)

	mgr.StopSession()

	// Status() returns "idle" when session == nil; "stopped" is only broadcast via SSE.
	waitState(t, mgr, "idle", 1*time.Second)

	mgr.mu.Lock()
	sess := mgr.session
	q := mgr.queue
	agent := mgr.agent
	mgr.mu.Unlock()

	if sess != nil {
		t.Error("session not cleared after stop")
	}
	if q != nil {
		t.Error("queue not cleared after stop")
	}
	if agent != nil {
		t.Error("agent not cleared after stop")
	}
}

func TestIntegration_SSE_StateAndMarkdownEvents(t *testing.T) {
	f := newOmlxFixture(t, []string{"m"})
	mgr := newMgr()

	// Subscribe to SSE before starting the session.
	evCh := mgr.bc.add()
	t.Cleanup(func() { mgr.bc.remove(evCh) })

	if err := mgr.StartLocalSession("m", "base", ""); err != nil {
		t.Fatalf("StartLocalSession: %v", err)
	}
	cleanupSessionDir(t, mgr)
	defer mgr.StopSession()

	// Collect events with a timeout.
	collect := func(timeout time.Duration, want EventType) bool {
		deadline := time.After(timeout)
		for {
			select {
			case ev := <-evCh:
				if ev.Type == want {
					return true
				}
			case <-deadline:
				return false
			}
		}
	}

	// Should receive "initializing" state event right after start.
	if !collect(3*time.Second, EventState) {
		t.Error("no state event received after StartLocalSession")
	}

	waitState(t, mgr, "ready", 3*time.Second)

	mgr.StartRecording(false) //nolint:errcheck
	mgr.queue.Enqueue("text", false)
	mgr.flushToAgent()

	f.respond(t, "# Doc", 3*time.Second)

	// Should receive a markdown event.
	if !collect(3*time.Second, EventMarkdown) {
		t.Error("no markdown event received after flush")
	}
}

func TestIntegration_ConcurrentFlushes_NoRace(t *testing.T) {
	f := newOmlxFixture(t, []string{"m"})
	mgr := newMgr()
	startReady(t, mgr, "m")
	cleanupSessionDir(t, mgr)
	defer mgr.StopSession()

	mgr.StartRecording(false) //nolint:errcheck

	// Fire multiple flushes concurrently — only the first should produce a request
	// (queue is empty after the first Flush).
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		mgr.queue.Enqueue("chunk", false)
		wg.Add(1)
		go func() {
			defer wg.Done()
			mgr.flushToAgent()
		}()
	}
	// Drain any requests that made it through.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case req := <-f.requests:
				req.release <- "ok"
			case <-time.After(500 * time.Millisecond):
				return
			}
		}
	}()
	wg.Wait()
	<-done
}

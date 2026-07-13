package upload

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tasksquad/daemon/config"
)

// newTestServer returns a fake worker backing the presign → PUT → attach
// pipeline, and a slice pointer capturing every attach request body so
// tests can assert on which key field was sent.
func newTestServer(t *testing.T, attachBodies *[]map[string]any) *httptest.Server {
	t.Helper()
	var srv *httptest.Server // captured by reference; assigned below before any request can arrive
	mux := http.NewServeMux()
	mux.HandleFunc("/daemon/r2/presign", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"ok":         true,
			"upload_url": srv.URL + "/upload-object",
			"key":        "agent123/session456/supervisor-snapshot.png",
			"dek":        "",
		})
	})
	mux.HandleFunc("/upload-object", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("expected PUT to upload URL, got %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/daemon/messages/", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		*attachBodies = append(*attachBodies, body)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true}) //nolint:errcheck
	})

	srv = httptest.NewServer(mux)
	return srv
}

func newTestUploader(srv *httptest.Server) *Uploader {
	cfg := &config.Config{Server: config.ServerConfig{URL: srv.URL}}
	return NewUploader(cfg, "test-token", "agent123", "test-agent")
}

func TestAttachImageToMessage_PostsImageKey(t *testing.T) {
	var attachBodies []map[string]any
	srv := newTestServer(t, &attachBodies)
	defer srv.Close()

	u := newTestUploader(srv)
	if err := u.AttachImageToMessage("msg1", "some/key.png", "snapshot.png", "image/png"); err != nil {
		t.Fatalf("AttachImageToMessage: %v", err)
	}
	if len(attachBodies) != 1 {
		t.Fatalf("expected 1 attach request, got %d", len(attachBodies))
	}
	if attachBodies[0]["image_key"] != "some/key.png" {
		t.Errorf("expected image_key in attach body, got %v", attachBodies[0])
	}
	if attachBodies[0]["filename"] != "snapshot.png" {
		t.Errorf("expected filename in attach body, got %v", attachBodies[0])
	}
	if attachBodies[0]["mime_type"] != "image/png" {
		t.Errorf("expected mime_type in attach body, got %v", attachBodies[0])
	}
	if _, hasTranscript := attachBodies[0]["transcript_key"]; hasTranscript {
		t.Errorf("did not expect transcript_key in image attach body, got %v", attachBodies[0])
	}
}

func TestAttachToMessage_StillPostsTranscriptKey(t *testing.T) {
	var attachBodies []map[string]any
	srv := newTestServer(t, &attachBodies)
	defer srv.Close()

	u := newTestUploader(srv)
	if err := u.AttachToMessage("msg1", "some/key.jsonl"); err != nil {
		t.Fatalf("AttachToMessage: %v", err)
	}
	if attachBodies[0]["transcript_key"] != "some/key.jsonl" {
		t.Errorf("expected transcript_key in attach body, got %v", attachBodies[0])
	}
}

func TestAttach_AsImage_RoutesToImageKey(t *testing.T) {
	var attachBodies []map[string]any
	srv := newTestServer(t, &attachBodies)
	defer srv.Close()

	u := newTestUploader(srv)
	err := u.Attach(AttachOptions{
		SessionID: "session456",
		MessageID: "msg1",
		Filename:  "supervisor-snapshot.png",
		Content:   []byte("fake png bytes"),
		AsImage:   true,
		MimeType:  "image/png",
	})
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if len(attachBodies) != 1 {
		t.Fatalf("expected 1 attach request, got %d", len(attachBodies))
	}
	if _, hasImage := attachBodies[0]["image_key"]; !hasImage {
		t.Errorf("expected image_key for AsImage:true, got %v", attachBodies[0])
	}
	if attachBodies[0]["mime_type"] != "image/png" {
		t.Errorf("expected mime_type for AsImage:true, got %v", attachBodies[0])
	}
	if _, hasTranscript := attachBodies[0]["transcript_key"]; hasTranscript {
		t.Errorf("did not expect transcript_key for AsImage:true, got %v", attachBodies[0])
	}
}

func TestAttach_DefaultRoutesToTranscriptKey(t *testing.T) {
	var attachBodies []map[string]any
	srv := newTestServer(t, &attachBodies)
	defer srv.Close()

	u := newTestUploader(srv)
	err := u.Attach(AttachOptions{
		SessionID: "session456",
		MessageID: "msg1",
		Filename:  "transcript.jsonl",
		Content:   []byte("fake transcript"),
	})
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if _, hasTranscript := attachBodies[0]["transcript_key"]; !hasTranscript {
		t.Errorf("expected transcript_key by default, got %v", attachBodies[0])
	}
}

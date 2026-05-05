package speechtomd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// mockOmlxServer returns a test server that handles /v1/models and /v1/chat/completions.
func mockOmlxServer(models []string, chatContent string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/models":
			data := map[string]any{"data": make([]map[string]string, len(models))}
			list := data["data"].([]map[string]string)
			for i, m := range models {
				list[i] = map[string]string{"id": m}
			}
			json.NewEncoder(w).Encode(data) //nolint:errcheck
		case "/v1/chat/completions":
			resp := map[string]any{
				"choices": []map[string]any{
					{"message": map[string]string{"content": chatContent, "role": "assistant"}},
				},
			}
			json.NewEncoder(w).Encode(resp) //nolint:errcheck
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestListLocalModels_success(t *testing.T) {
	srv := mockOmlxServer([]string{"model-a", "model-b"}, "")
	defer srv.Close()

	models, err := ListLocalModels(srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("expected 2 models, got %d", len(models))
	}
	if models[0] != "model-a" || models[1] != "model-b" {
		t.Errorf("unexpected models: %v", models)
	}
}

func TestListLocalModels_serverDown(t *testing.T) {
	_, err := ListLocalModels("http://127.0.0.1:19999")
	if err == nil {
		t.Fatal("expected error when server is down")
	}
}

func TestLocalAgentStart_autoSelectsFirstModel(t *testing.T) {
	srv := mockOmlxServer([]string{"first-model", "second-model"}, "")
	defer srv.Close()

	a := newLocalModelAgent(srv.URL, "")
	if err := a.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	models, err := a.ListModels()
	if err != nil {
		t.Fatalf("ListModels failed: %v", err)
	}
	if len(models) != 2 {
		t.Errorf("expected 2 models, got %d", len(models))
	}
	if a.model != "first-model" {
		t.Errorf("expected auto-selected model 'first-model', got %q", a.model)
	}
}

func TestLocalAgentStart_respectsConfiguredModel(t *testing.T) {
	srv := mockOmlxServer([]string{"first-model", "second-model"}, "")
	defer srv.Close()

	a := newLocalModelAgent(srv.URL, "second-model")
	if err := a.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	if a.model != "second-model" {
		t.Errorf("expected configured model 'second-model', got %q", a.model)
	}
}

func TestLocalAgentStart_emptyModelList(t *testing.T) {
	srv := mockOmlxServer([]string{}, "")
	defer srv.Close()

	a := newLocalModelAgent(srv.URL, "")
	if err := a.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	if a.model != "" {
		t.Errorf("expected empty model when none available, got %q", a.model)
	}
}

func TestLocalAgentComplete_appendMode(t *testing.T) {
	const wantContent = "# Meeting Notes\n\nSome content here."
	var capturedBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/chat/completions" {
			json.NewDecoder(r.Body).Decode(&capturedBody) //nolint:errcheck
			resp := map[string]any{
				"choices": []map[string]any{
					{"message": map[string]string{"content": wantContent, "role": "assistant"}},
				},
			}
			json.NewEncoder(w).Encode(resp) //nolint:errcheck
		}
	}))
	defer srv.Close()

	a := newLocalModelAgent(srv.URL, "test-model")
	got, err := a.Complete("existing md", "new transcript text", false)
	if err != nil {
		t.Fatalf("Complete failed: %v", err)
	}
	if got != wantContent {
		t.Errorf("expected content %q, got %q", wantContent, got)
	}

	// Verify XML input structure sent to the model.
	msgs, _ := capturedBody["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	userMsg, _ := msgs[1].(map[string]any)
	userContent, _ := userMsg["content"].(string)
	if !strings.Contains(userContent, "<current_markdown>") {
		t.Error("user message missing <current_markdown> tag")
	}
	if !strings.Contains(userContent, "<new_transcript>") {
		t.Error("user message missing <new_transcript> tag")
	}
	if !strings.Contains(userContent, "<mode>append</mode>") {
		t.Error("user message missing <mode>append</mode>")
	}
	if !strings.Contains(userContent, "existing md") {
		t.Error("user message missing current markdown content")
	}
	if !strings.Contains(userContent, "new transcript text") {
		t.Error("user message missing transcript content")
	}
}

func TestLocalAgentComplete_editMode(t *testing.T) {
	var capturedBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewDecoder(r.Body).Decode(&capturedBody) //nolint:errcheck
		resp := map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"content": "edited", "role": "assistant"}}},
		}
		json.NewEncoder(w).Encode(resp) //nolint:errcheck
	}))
	defer srv.Close()

	a := newLocalModelAgent(srv.URL, "test-model")
	if _, err := a.Complete("md", "change title to Foo", true); err != nil {
		t.Fatalf("Complete failed: %v", err)
	}

	msgs, _ := capturedBody["messages"].([]any)
	userMsg, _ := msgs[1].(map[string]any)
	userContent, _ := userMsg["content"].(string)
	if !strings.Contains(userContent, "<mode>edit</mode>") {
		t.Errorf("expected <mode>edit</mode> in user content, got: %s", userContent)
	}
}

func TestLocalAgentComplete_stripsThinkTags(t *testing.T) {
	rawContent := "<think>\nsome internal reasoning\n</think>\n# Result\n\nClean output."
	srv := mockOmlxServer(nil, rawContent)
	// Override handler to return the raw content with think tags.
	srv.Close()
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		resp := map[string]any{
			"choices": []map[string]any{
				{"message": map[string]string{"content": rawContent, "role": "assistant"}},
			},
		}
		json.NewEncoder(w).Encode(resp) //nolint:errcheck
	}))
	defer srv.Close()

	a := newLocalModelAgent(srv.URL, "test-model")
	got, err := a.Complete("", "transcript", false)
	if err != nil {
		t.Fatalf("Complete failed: %v", err)
	}
	if strings.Contains(got, "<think>") {
		t.Errorf("think tags not stripped from output: %q", got)
	}
	if !strings.Contains(got, "# Result") {
		t.Errorf("expected remaining content after stripping, got: %q", got)
	}
}

func TestLocalAgentComplete_nonOKStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "model overloaded", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	a := newLocalModelAgent(srv.URL, "test-model")
	_, err := a.Complete("", "text", false)
	if err == nil {
		t.Fatal("expected error on non-200 status")
	}
}

func TestLocalAgentComplete_emptyChoices(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{}}) //nolint:errcheck
	}))
	defer srv.Close()

	a := newLocalModelAgent(srv.URL, "test-model")
	_, err := a.Complete("", "text", false)
	if err == nil {
		t.Fatal("expected error on empty choices")
	}
	if !strings.Contains(err.Error(), "no choices") {
		t.Errorf("expected 'no choices' error, got: %v", err)
	}
}

func TestLocalAgentComplete_systemPromptPresent(t *testing.T) {
	var capturedBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewDecoder(r.Body).Decode(&capturedBody) //nolint:errcheck
		resp := map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"content": "ok", "role": "assistant"}}},
		}
		json.NewEncoder(w).Encode(resp) //nolint:errcheck
	}))
	defer srv.Close()

	a := newLocalModelAgent(srv.URL, "test-model")
	if _, err := a.Complete("", "text", false); err != nil {
		t.Fatalf("Complete failed: %v", err)
	}

	msgs, _ := capturedBody["messages"].([]any)
	if len(msgs) < 2 {
		t.Fatal("expected at least 2 messages (system + user)")
	}
	sysMsg, _ := msgs[0].(map[string]any)
	if sysMsg["role"] != "system" {
		t.Errorf("first message should be system role, got %v", sysMsg["role"])
	}
	sysContent, _ := sysMsg["content"].(string)
	if !strings.Contains(sysContent, "documentation assistant") {
		t.Errorf("system prompt missing expected content, got: %q", sysContent)
	}
}

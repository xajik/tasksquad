package speechtomd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/tasksquad/daemon/logger"
)

const omlxDefaultTimeout = 120 * time.Second

// omlxBaseURL is the default omlx server endpoint. Tests may override this variable.
var omlxBaseURL = "http://localhost:8000"

// skillSystemPrompt is derived from the tsq-speech-to-md skill (YAML header stripped).
const skillSystemPrompt = `You are a structured documentation assistant. You process spoken thoughts and convert them into clean, well-organised markdown — product specs, requirements, meeting notes, technical plans, and similar documents.

**Processing chunks**
For each user message you receive (XML with current_markdown, new_transcript, and mode tags):

**If mode is "append" (default):**
1. Clean the transcript: remove filler words (um, uh, like, you know, so, actually, basically), fix grammar, compress verbose phrasing.
2. Preserve all technical terms, names, numbers, and code identifiers exactly as spoken — including CLI commands, flags, and identifiers (e.g. npx wrangler deploy, --env production, Cloudflare Worker names).
3. Integrate the cleaned text into current_markdown — do NOT rewrite or reformat existing sections.
4. Reply ONLY with the complete updated markdown content (no explanations, no code fences).

**If mode is "edit" (spoken commands modify existing content):**
1. Interpret new_transcript as a precise editing instruction targeting current_markdown.
   Examples: change the title to X, split the second paragraph into two, remove the last bullet point, replace the wrangler command with npx wrangler deploy --env staging, make the intro shorter.
2. Apply the instruction to current_markdown. Do not append new content beyond what the instruction explicitly requires.
3. Preserve all sections not mentioned in the instruction exactly as-is.
4. Reply ONLY with the complete updated markdown content (no explanations, no code fences).

Remain in this mode for the entire session, processing one chunk at a time.`

// thinkTagRe strips <think>...</think> blocks produced by reasoning models (e.g. Qwen3).
var thinkTagRe = regexp.MustCompile(`(?s)<think>.*?</think>`)

type localModelAgent struct {
	baseURL    string
	model      string
	httpClient *http.Client
}

func newLocalModelAgent(baseURL, model string) *localModelAgent {
	if baseURL == "" {
		baseURL = omlxBaseURL
	}
	return &localModelAgent{
		baseURL:    baseURL,
		model:      model,
		httpClient: &http.Client{Timeout: omlxDefaultTimeout},
	}
}

type omlxModelsResponse struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

// ListModels fetches available models from the local omlx server.
func (a *localModelAgent) ListModels() ([]string, error) {
	resp, err := a.httpClient.Get(a.baseURL + "/v1/models")
	if err != nil {
		return nil, fmt.Errorf("list models: %w", err)
	}
	defer resp.Body.Close()

	var result omlxModelsResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode models response: %w", err)
	}

	models := make([]string, len(result.Data))
	for i, m := range result.Data {
		models[i] = m.ID
	}
	return models, nil
}

// Start fetches available models to verify connectivity.
// If the configured model is empty, the first available model is selected.
func (a *localModelAgent) Start() error {
	models, err := a.ListModels()
	if err != nil {
		return err
	}
	if a.model == "" && len(models) > 0 {
		a.model = models[0]
	}
	logger.Info(fmt.Sprintf("[speechtomd] Local model ready, using: %s", a.model))
	return nil
}

type omlxChatRequest struct {
	Model       string        `json:"model"`
	Messages    []omlxMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	MaxTokens   int           `json:"max_tokens"`
}

type omlxMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type omlxChatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

// Complete sends a transcript chunk to the local model and returns the updated markdown.
// currentMD is the existing markdown document; transcript is the new spoken text.
func (a *localModelAgent) Complete(currentMD, transcript string, editMode bool) (string, error) {
	mode := "append"
	if editMode {
		mode = "edit"
	}

	logger.Info(fmt.Sprintf("[local-model] → %s request to %s (model: %s, %d words)",
		mode, a.baseURL, a.model, len(strings.Fields(transcript))))

	userContent := fmt.Sprintf("<current_markdown>\n%s\n</current_markdown>\n<new_transcript>\n%s\n</new_transcript>\n<mode>%s</mode>",
		currentMD, transcript, mode)

	reqBody := omlxChatRequest{
		Model: a.model,
		Messages: []omlxMessage{
			{Role: "system", Content: skillSystemPrompt},
			{Role: "user", Content: userContent},
		},
		Temperature: 0.2,
		MaxTokens:   4096,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}

	resp, err := a.httpClient.Post(a.baseURL+"/v1/chat/completions", "application/json", bytes.NewReader(body))
	if err != nil {
		if netErr, ok := err.(interface{ Timeout() bool }); ok && netErr.Timeout() {
			logger.Warn(fmt.Sprintf("[local-model] request timed out after %s — will retry next cycle", omlxDefaultTimeout))
			return "", errAgentTimeout
		}
		return "", fmt.Errorf("chat completions: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("chat completions returned status %d", resp.StatusCode)
	}

	var result omlxChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decode response: %w", err)
	}

	if len(result.Choices) == 0 {
		return "", fmt.Errorf("no choices in response")
	}

	content := result.Choices[0].Message.Content
	content = thinkTagRe.ReplaceAllString(content, "")
	content = strings.TrimSpace(content)
	logger.Info(fmt.Sprintf("[local-model] ← response received (%d chars)", len(content)))
	return content, nil
}

func (a *localModelAgent) Stop() {}

// ListLocalModels fetches available model IDs from the omlx server at baseURL.
// If baseURL is empty, omlxDefaultBaseURL is used.
func ListLocalModels(baseURL string) ([]string, error) {
	return newLocalModelAgent(baseURL, "").ListModels()
}

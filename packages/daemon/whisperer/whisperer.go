package whisperer

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ModelSize identifies a Whisper model variant.
type ModelSize string

const (
	Tiny   ModelSize = "tiny"
	Base   ModelSize = "base"
	Small  ModelSize = "small"
	Medium ModelSize = "medium"
	Large  ModelSize = "large"
)

// AllSizes lists models from smallest to largest.
var AllSizes = []ModelSize{Tiny, Base, Small, Medium, Large}

// modelsDir returns ~/.tasksquad/models/tts.
func modelsDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".tasksquad", "models", "tts")
}

// ModelPath returns the absolute path for a model file, or an error if it is not present.
func ModelPath(size ModelSize) (string, error) {
	dir := modelsDir()
	path := filepath.Join(dir, fmt.Sprintf("ggml-%s.bin", size))
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return "", fmt.Errorf("model %s not found at %s — use the UI to download it", size, path)
	}
	return path, nil
}

// ModelStatus returns download status for each known model.
func ModelStatus() []map[string]any {
	dir := modelsDir()
	var result []map[string]any
	for _, size := range AllSizes {
		path := filepath.Join(dir, fmt.Sprintf("ggml-%s.bin", size))
		info, err := os.Stat(path)
		downloaded := err == nil
		var sizeBytes int64
		if downloaded {
			sizeBytes = info.Size()
		}
		result = append(result, map[string]any{
			"size":       string(size),
			"downloaded": downloaded,
			"bytes":      sizeBytes,
			"path":       path,
		})
	}
	return result
}

// HuggingFaceURL returns the download URL for a model from the ggerganov/whisper.cpp repo.
func HuggingFaceURL(size ModelSize) string {
	return fmt.Sprintf(
		"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-%s.bin",
		size,
	)
}

// EnsureModelsDir creates the models directory if it does not exist.
func EnsureModelsDir() error {
	return os.MkdirAll(modelsDir(), 0755)
}

// ExtractLastAssistantText reads a Claude Code JSONL transcript and returns the
// last assistant text block. Used as a fallback when the agent has not posted
// an explicit /hooks/speech-to-md/response.
func ExtractLastAssistantText(path string) string {
	if path == "" {
		return ""
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	var lastText string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var entry struct {
			Type    string `json:"type"`
			Message struct {
				Role    string `json:"role"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &entry) != nil {
			continue
		}
		if entry.Type != "assistant" && entry.Message.Role != "assistant" {
			continue
		}
		var parts []string
		for _, c := range entry.Message.Content {
			if c.Type == "text" && c.Text != "" {
				parts = append(parts, c.Text)
			}
		}
		if len(parts) > 0 {
			lastText = strings.Join(parts, "\n")
		}
	}
	return strings.TrimSpace(lastText)
}

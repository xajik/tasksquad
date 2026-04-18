package whisperer

import (
	"fmt"
	"os"
	"path/filepath"
)

type ModelSize string

const (
	Tiny   ModelSize = "tiny"
	Base   ModelSize = "base"
	Small  ModelSize = "small"
	Medium ModelSize = "medium"
	Large  ModelSize = "large"
)

// EnsureModel checks if the whisper model is downloaded and downloads it if not.
func EnsureModel(size ModelSize) (string, error) {
	home, _ := os.UserHomeDir()
	modelsDir := filepath.Join(home, ".tasksquad", "models")
	if err := os.MkdirAll(modelsDir, 0755); err != nil {
		return "", err
	}

	modelFile := filepath.Join(modelsDir, fmt.Sprintf("ggml-%s.bin", size))
	if _, err := os.Stat(modelFile); os.IsNotExist(err) {
		// TODO: Download from HuggingFace
        // For example: https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
		return "", fmt.Errorf("model %s not found. Download it to %s", size, modelFile)
	}

	return modelFile, nil
}

// Transcribe transcribes an audio file using the whisper model.
func Transcribe(audioFile, modelFile string) (string, error) {
    // TODO: Call whisper.cpp or a Go binding
    return "", fmt.Errorf("transcription not implemented yet")
}

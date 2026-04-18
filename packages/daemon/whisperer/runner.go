package whisperer

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// findBinary searches for the whisper.cpp CLI binary in PATH.
// Homebrew installs it as "whisper-cli"; older builds use "whisper-cpp".
func findBinary() (string, error) {
	for _, name := range []string{"whisper-cli", "whisper-cpp", "main"} {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("whisper-cli not found — install with: brew install whisper-cpp")
}

// CheckPrereqs returns an error for each missing prerequisite binary.
// Returns nil if all required tools are present.
func CheckPrereqs() map[string]string {
	issues := map[string]string{}
	if _, err := findBinary(); err != nil {
		issues["whisper"] = "whisper-cli not found — brew install whisper-cpp"
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		issues["ffmpeg"] = "ffmpeg not found — brew install ffmpeg"
	}
	return issues
}

// TranscribeBytes converts raw audio bytes (WebM/OGG from MediaRecorder) to a
// WAV file, then runs the whisper-cli binary and returns the transcript text.
func TranscribeBytes(audioData []byte, modelPath string) (string, error) {
	bin, err := findBinary()
	if err != nil {
		return "", err
	}

	// Write audio to a temp file.
	tmpDir, err := os.MkdirTemp("", "tsq-voice-*")
	if err != nil {
		return "", fmt.Errorf("mktemp: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	inFile := filepath.Join(tmpDir, "audio.webm")
	if err := os.WriteFile(inFile, audioData, 0644); err != nil {
		return "", fmt.Errorf("write audio: %w", err)
	}

	// Convert to WAV (16 kHz mono PCM-16) using ffmpeg.
	wavFile := filepath.Join(tmpDir, "audio.wav")
	if err := convertToWAV(inFile, wavFile); err != nil {
		return "", fmt.Errorf("convert to WAV: %w", err)
	}

	return runWhisper(bin, modelPath, wavFile)
}

// TranscribeFile transcribes an existing audio file on disk.
func TranscribeFile(audioPath, modelPath string) (string, error) {
	bin, err := findBinary()
	if err != nil {
		return "", err
	}

	tmpDir, err := os.MkdirTemp("", "tsq-voice-*")
	if err != nil {
		return "", fmt.Errorf("mktemp: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	wavFile := filepath.Join(tmpDir, "audio.wav")
	if err := convertToWAV(audioPath, wavFile); err != nil {
		return "", fmt.Errorf("convert to WAV: %w", err)
	}

	return runWhisper(bin, modelPath, wavFile)
}

// convertToWAV runs ffmpeg to convert any audio format to 16 kHz mono PCM-16 WAV.
func convertToWAV(input, output string) error {
	cmd := exec.Command("ffmpeg",
		"-y",          // overwrite
		"-i", input,   // input file
		"-ar", "16000", // 16 kHz
		"-ac", "1",    // mono
		"-c:a", "pcm_s16le", // PCM 16-bit little-endian
		output,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg: %w — output: %s", err, string(out))
	}
	return nil
}

// runWhisper calls the whisper-cli binary and returns the transcript as plain text.
func runWhisper(bin, modelPath, wavFile string) (string, error) {
	// -nt   = no timestamps
	// -otxt = write .txt output file (we read stdout instead)
	cmd := exec.Command(bin,
		"-m", modelPath,
		"-f", wavFile,
		"-nt",
		"--output-txt",
	)
	out, err := cmd.Output()
	if err != nil {
		// whisper-cli exits non-zero on warnings; check if output is usable.
		if len(out) == 0 {
			return "", fmt.Errorf("whisper-cli: %w", err)
		}
	}

	// whisper-cli writes to stdout or to <wavFile>.txt — try both.
	text := strings.TrimSpace(string(out))
	if text == "" {
		txtPath := wavFile + ".txt"
		if data, readErr := os.ReadFile(txtPath); readErr == nil {
			text = strings.TrimSpace(string(data))
		}
	}

	return cleanTranscript(text), nil
}

// cleanTranscript removes whisper timestamps like [00:00.000 --> 00:03.000] and trims whitespace.
func cleanTranscript(raw string) string {
	lines := strings.Split(raw, "\n")
	var out []string
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		// Strip timestamp markers emitted in verbose mode.
		if strings.HasPrefix(l, "[") && strings.Contains(l, "-->") {
			continue
		}
		out = append(out, l)
	}
	return strings.Join(out, " ")
}

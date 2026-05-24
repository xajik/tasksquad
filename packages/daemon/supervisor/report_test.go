package supervisor

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestReadSupervisorOutput_MissingFile(t *testing.T) {
	result := readSupervisorOutput("/tmp/tsq-test-nonexistent-file-xyz.log")
	if result != "" {
		t.Errorf("expected empty string for missing file, got %q", result)
	}
}

func TestReadSupervisorOutput_EmptyFile(t *testing.T) {
	f, _ := os.CreateTemp("", "tsq-sup-*.log")
	f.Close()
	defer os.Remove(f.Name())
	result := readSupervisorOutput(f.Name())
	if result != "" {
		t.Errorf("expected empty string for empty file, got %q", result)
	}
}

func TestReadSupervisorOutput_NoOutputMarker(t *testing.T) {
	f, _ := os.CreateTemp("", "tsq-sup-*.log")
	f.WriteString("# header\n--- CONTEXT ---\nsome context\n") //nolint:errcheck
	f.Close()
	defer os.Remove(f.Name())
	result := readSupervisorOutput(f.Name())
	if result != "" {
		t.Errorf("expected empty string when no OUTPUT marker, got %q", result)
	}
}

func TestReadSupervisorOutput_EmptyOutput(t *testing.T) {
	f, _ := os.CreateTemp("", "tsq-sup-*.log")
	f.WriteString("# header\n--- OUTPUT ---\n") //nolint:errcheck
	f.Close()
	defer os.Remove(f.Name())
	result := readSupervisorOutput(f.Name())
	if result != "" {
		t.Errorf("expected empty string for empty output section, got %q", result)
	}
}

func TestReadSupervisorOutput_ShortOutput(t *testing.T) {
	f, _ := os.CreateTemp("", "tsq-sup-*.log")
	f.WriteString("# header\n--- OUTPUT ---\nok\n") //nolint:errcheck
	f.Close()
	defer os.Remove(f.Name())
	result := readSupervisorOutput(f.Name())
	if result != "" {
		t.Errorf("expected empty for output < 10 chars, got %q", result)
	}
}

func TestReadSupervisorOutput_NormalOutput(t *testing.T) {
	f, _ := os.CreateTemp("", "tsq-sup-*.log")
	body := "The agent was stuck at a selection prompt. I sent option 1."
	f.WriteString("# header\n--- OUTPUT ---\n" + body + "\n") //nolint:errcheck
	f.Close()
	defer os.Remove(f.Name())
	result := readSupervisorOutput(f.Name())
	if result != body {
		t.Errorf("expected %q, got %q", body, result)
	}
}

func TestReadSupervisorOutput_StripsTrailingMarker(t *testing.T) {
	f, _ := os.CreateTemp("", "tsq-sup-*.log")
	body := "Agent was running normally."
	content := "# header\n--- OUTPUT ---\n" + body + "\n--- SUPERVISOR TIMEOUT/EXIT: 2026-01-01T00:00:00Z ---\n"
	f.WriteString(content) //nolint:errcheck
	f.Close()
	defer os.Remove(f.Name())
	result := readSupervisorOutput(f.Name())
	if result != body {
		t.Errorf("expected trailing marker stripped, got %q", result)
	}
}

func TestReadSupervisorOutput_TruncatesLongOutput(t *testing.T) {
	f, _ := os.CreateTemp("", "tsq-sup-*.log")
	var lines []string
	for i := range maxRawOutputLines + 10 {
		lines = append(lines, fmt.Sprintf("line %d of supervisor output", i))
	}
	content := "# header\n--- OUTPUT ---\n" + strings.Join(lines, "\n") + "\n"
	f.WriteString(content) //nolint:errcheck
	f.Close()
	defer os.Remove(f.Name())
	result := readSupervisorOutput(f.Name())
	if !strings.HasPrefix(result, "…\n") {
		t.Errorf("expected truncated output to start with '…\\n', got: %s", result[:min(50, len(result))])  //nolint:gocritic
	}
	resultLines := strings.Split(strings.TrimPrefix(result, "…\n"), "\n")
	if len(resultLines) != maxRawOutputLines {
		t.Errorf("expected %d lines after truncation, got %d", maxRawOutputLines, len(resultLines))
	}
	if !strings.HasSuffix(result, fmt.Sprintf("line %d of supervisor output", maxRawOutputLines+9)) {
		t.Errorf("expected last line to be the final input line, got: %s", result[max(0, len(result)-50):])
	}
}

package upload

import (
	"bytes"
	"fmt"
	"net/http"
	"os"
	"strings"
)

// UploadLog puts the log file at logPath to the presigned R2 URL.
func UploadLog(uploadURL, logPath string) error {
	data, err := os.ReadFile(logPath)
	if err != nil {
		return fmt.Errorf("read log: %w", err)
	}
	req, err := http.NewRequest(http.MethodPut, uploadURL, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("upload failed: %s", resp.Status)
	}
	return nil
}

// ExtractFinalText returns the last ~500 non-whitespace characters of the log.
func ExtractFinalText(logPath string) string {
	data, err := os.ReadFile(logPath)
	if err != nil {
		return ""
	}
	text := strings.TrimSpace(string(data))
	if len(text) > 500 {
		text = text[len(text)-500:]
	}
	return text
}

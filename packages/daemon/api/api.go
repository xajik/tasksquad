package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/tasksquad/daemon/config"
)

func Post(cfg *config.Config, token, path string, body any) (map[string]any, error) {
	jsonBody, _ := json.Marshal(body)

	req, err := http.NewRequest("POST", cfg.Server.URL+path, bytes.NewReader(jsonBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-TSQ-Token", token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
	}

	var result map[string]any
	json.Unmarshal(b, &result)
	return result, nil
}

func Get(cfg *config.Config, token, path string) (map[string]any, error) {
	req, err := http.NewRequest("GET", cfg.Server.URL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-TSQ-Token", token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
	}

	var result map[string]any
	json.Unmarshal(b, &result)
	return result, nil
}

// PostBatch sends a batch heartbeat request and handles ETag-based 304 responses.
// tokens are sent inside the request body; no X-TSQ-Token header is used.
// Returns the per-agent response slice, the new ETag, whether HTTP 304 was received, and any error.
func PostBatch(cfg *config.Config, path string, entries []map[string]any, etag string) ([]map[string]any, string, bool, error) {
	body := map[string]any{"agents": entries}
	jsonBody, _ := json.Marshal(body)

	req, err := http.NewRequest("POST", cfg.Server.URL+path, bytes.NewReader(jsonBody))
	if err != nil {
		return nil, "", false, err
	}
	req.Header.Set("Content-Type", "application/json")
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", false, err
	}
	defer resp.Body.Close()

	newEtag := resp.Header.Get("ETag")

	if resp.StatusCode == 304 {
		return nil, newEtag, true, nil
	}

	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, newEtag, false, fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
	}

	var result map[string]any
	json.Unmarshal(b, &result) //nolint:errcheck

	rawAgents, _ := result["agents"].([]any)
	agentMaps := make([]map[string]any, 0, len(rawAgents))
	for _, a := range rawAgents {
		if m, ok := a.(map[string]any); ok {
			agentMaps = append(agentMaps, m)
		}
	}

	return agentMaps, newEtag, false, nil
}

func PutBytes(url string, data []byte) error {
	req, err := http.NewRequest("PUT", url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upload HTTP %d: %s", resp.StatusCode, b)
	}
	return nil
}


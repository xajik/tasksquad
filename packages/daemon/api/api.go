package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/tasksquad/daemon/config"
)

var httpClient = &http.Client{Timeout: 60 * time.Second}

// Post sends a JSON POST to the worker API using Firebase ID token auth.
// agentID is forwarded in the X-TSQ-Agent header so the server can scope the
// request to the correct agent without a per-agent token.
func Post(cfg *config.Config, token, agentID, path string, body any) (map[string]any, error) {
	jsonBody, _ := json.Marshal(body)

	req, err := http.NewRequest("POST", cfg.Server.URL+path, bytes.NewReader(jsonBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	if agentID != "" {
		req.Header.Set("X-TSQ-Agent", agentID)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
	}

	var result map[string]any
	json.Unmarshal(b, &result) //nolint:errcheck
	return result, nil
}

// Get sends a JSON GET to the worker API using Firebase ID token auth.
func Get(cfg *config.Config, token, path string) (map[string]any, error) {
	return GetConditional(cfg, token, path, "")
}

// GetConditional sends a conditional GET with an optional If-None-Match etag.
// Returns (nil, nil) when the server responds with 304 Not Modified.
func GetConditional(cfg *config.Config, token, path, etag string) (map[string]any, error) {
	req, err := http.NewRequest("GET", cfg.Server.URL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified {
		return nil, nil
	}

	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
	}

	var result map[string]any
	json.Unmarshal(b, &result) //nolint:errcheck
	return result, nil
}

// GetWithAgent sends a JSON GET to the worker API using Firebase ID token
// auth, scoped to a specific agent via the X-TSQ-Agent header. Plain Get has
// no way to set that header, which is fine for firebaseRoute (user-scoped)
// endpoints but fails daemonRoute-wrapped GET endpoints — those require
// X-TSQ-Agent the same way Post does, and reject the request with 400
// missing_agent_id without it.
func GetWithAgent(cfg *config.Config, token, agentID, path string) (map[string]any, error) {
	req, err := http.NewRequest("GET", cfg.Server.URL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if agentID != "" {
		req.Header.Set("X-TSQ-Agent", agentID)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
	}

	var result map[string]any
	json.Unmarshal(b, &result) //nolint:errcheck
	return result, nil
}

// GetBytesWithAgent sends a GET to the worker API scoped to a specific agent
// via X-TSQ-Agent, returning the raw response body — for binary downloads
// (e.g. an inbound message attachment) rather than JSON.
func GetBytesWithAgent(cfg *config.Config, token, agentID, path string) ([]byte, error) {
	req, err := http.NewRequest("GET", cfg.Server.URL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if agentID != "" {
		req.Header.Set("X-TSQ-Agent", agentID)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
	}
	return b, nil
}

// PostBatch sends a batch heartbeat request and handles ETag-based 304 responses.
// The Firebase ID token is sent in the Authorization header; agent IDs and statuses
// are sent in the request body (no per-agent tokens needed).
// Returns the per-agent response slice, the new ETag, whether HTTP 304 was received, and any error.
func PostBatch(cfg *config.Config, token, path string, entries []map[string]any, etag string) ([]map[string]any, string, bool, error) {
	body := map[string]any{"agents": entries}
	jsonBody, _ := json.Marshal(body)

	req, err := http.NewRequest("POST", cfg.Server.URL+path, bytes.NewReader(jsonBody))
	if err != nil {
		return nil, "", false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}

	resp, err := httpClient.Do(req)
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

	resp, err := httpClient.Do(req)
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

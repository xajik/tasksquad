package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// CustomerClient deliberately omits X-TSQ-Agent. All authorization is user-scoped.
type CustomerClient struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func (c CustomerClient) Request(ctx context.Context, method, path string, body map[string]any, files []string) (map[string]any, error) {
	u, err := url.Parse(c.BaseURL)
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, fmt.Errorf("invalid API URL")
	}
	var data bytes.Buffer
	contentType := "application/json"
	if len(files) > 0 {
		if len(files) > 3 {
			return nil, fmt.Errorf("at most three images are allowed")
		}
		writer := multipart.NewWriter(&data)
		for key, value := range body {
			text, ok := value.(string)
			if !ok {
				encoded, e := json.Marshal(value)
				if e != nil {
					return nil, e
				}
				text = string(encoded)
			}
			if err := writer.WriteField(key, text); err != nil {
				return nil, err
			}
		}
		for _, filename := range files {
			file, err := os.Open(filename)
			if err != nil {
				return nil, fmt.Errorf("cannot open attachment %s", filepath.Base(filename))
			}
			contents, err := io.ReadAll(io.LimitReader(file, 8*1024*1024+1))
			_ = file.Close()
			if err != nil || len(contents) > 8*1024*1024 {
				return nil, fmt.Errorf("attachment exceeds 8 MiB or cannot be read")
			}
			mime := http.DetectContentType(contents)
			if mime != "image/png" && mime != "image/jpeg" && mime != "image/gif" && mime != "image/webp" {
				return nil, fmt.Errorf("unsupported image type: %s", mime)
			}
			name := strings.NewReplacer("\"", "_", "\r", "_", "\n", "_", "\\", "_").Replace(filepath.Base(filename))
			h := textproto.MIMEHeader{}
			h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="images"; filename="%s"`, name))
			h.Set("Content-Type", mime)
			part, err := writer.CreatePart(h)
			if err != nil {
				return nil, err
			}
			if _, err := part.Write(contents); err != nil {
				return nil, err
			}
		}
		if err := writer.Close(); err != nil {
			return nil, err
		}
		contentType = writer.FormDataContentType()
	} else if body != nil {
		if err := json.NewEncoder(&data).Encode(body); err != nil {
			return nil, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.BaseURL, "/")+path, &data)
	if err != nil {
		return nil, fmt.Errorf("invalid request")
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", contentType)
	}
	client := c.HTTP
	if client == nil {
		client = httpClient
	}
	// Never forward a reusable token through an API redirect.
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := copyClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("API request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("API HTTP %d", resp.StatusCode)
	}
	if resp.StatusCode == 204 {
		return map[string]any{"ok": true}, nil
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 16*1024*1024))
	decoder.UseNumber()
	var result map[string]any
	if err := decoder.Decode(&result); err != nil {
		return nil, fmt.Errorf("invalid API response")
	}
	return result, nil
}

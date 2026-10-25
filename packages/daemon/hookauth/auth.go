// Package hookauth authenticates local provider and native-client callbacks.
// The per-port capability is shared with the Swift daemon through a private file.
package hookauth

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func Path(port int) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".tasksquad", fmt.Sprintf("hooks-%d.token", port))
}

func Read(port int) (string, error) {
	info, err := os.Lstat(Path(port))
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return "", fmt.Errorf("hook capability must be a private regular file")
	}
	data, err := os.ReadFile(Path(port))
	if err != nil {
		return "", err
	}
	token := string(data)
	decoded, err := hex.DecodeString(token)
	if err != nil || len(decoded) != 32 {
		return "", fmt.Errorf("invalid hook capability")
	}
	return token, nil
}

func LoadOrCreate(port int) (string, error) {
	if token, err := Read(port); err == nil {
		return token, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(Path(port)), 0700); err != nil {
		return "", err
	}
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	token := hex.EncodeToString(data)
	f, err := os.OpenFile(Path(port), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		return Read(port)
	}
	if err != nil {
		return "", err
	}
	_, writeErr := f.WriteString(token)
	closeErr := f.Close()
	if writeErr != nil {
		return "", writeErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	return token, nil
}

// Env explicitly passes the capability into tmux sessions as well as child processes.
func Env(port int) []string {
	token, err := Read(port)
	if err != nil {
		token = os.Getenv("TSQ_HOOK_TOKEN")
		if token == "" {
			return nil
		}
	}
	return []string{"TSQ_HOOK_TOKEN=" + token}
}

func Authorize(req *http.Request, port int) error {
	token, err := Read(port)
	if err != nil {
		return fmt.Errorf("read daemon hook capability: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return nil
}

// URL is for Claw's body-less HTTP hooks, whose local settings do not support
// dynamic headers. Their settings file is owner-only and must never be committed.
func URL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		return raw
	}
	token, err := Read(port)
	if err != nil {
		return raw
	}
	q := u.Query()
	q.Set("hook_token", token)
	u.RawQuery = q.Encode()
	return u.String()
}

func LocalHost(host string) bool {
	u, err := url.Parse("http://" + host)
	return err == nil && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == "" &&
		(strings.EqualFold(u.Hostname(), "localhost") || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")
}

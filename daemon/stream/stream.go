package stream

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/tmux"
)

// Run polls the tmux pane every 2 seconds and pushes changed lines to the API.
// It exits when done is closed.
func Run(cfg *config.Config, agentID, tmuxSession string, done <-chan struct{}) {
	var prevHash [32]byte
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			output := tmux.CapturePane(tmuxSession)
			hash := sha256.Sum256([]byte(output))
			if hash == prevHash {
				continue
			}
			prevHash = hash
			lines := strings.Split(output, "\n")
			push(cfg, agentID, "line", lines)
		}
	}
}

func push(cfg *config.Config, agentID, typ string, lines []string) {
	body, _ := json.Marshal(map[string]any{"type": typ, "lines": lines})
	req, err := http.NewRequest(http.MethodPost,
		fmt.Sprintf("%s/daemon/push/%s", cfg.Server.URL, agentID),
		bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-TSQ-Token", cfg.Server.Token)
	http.DefaultClient.Do(req) //nolint:errcheck
}

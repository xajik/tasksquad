package stream

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"time"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/tmux"
)

func Run(cfg *config.Config, agentID, tmuxSession string, done <-chan struct{}) {
	var prevHash [32]byte
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			output, err := tmux.CapturePane(tmuxSession)
			if err != nil {
				continue
			}

			hash := sha256.Sum256([]byte(output))
			if hash == prevHash {
				continue
			}
			prevHash = hash

			lines := strings.Split(output, "\n")
			api.Post(cfg, fmt.Sprintf("/daemon/push/%s", agentID), map[string]any{
				"type":  "line",
				"lines": lines,
			})
			logger.Debug(fmt.Sprintf("[stream] Pushed %d lines for agent %s", len(lines), agentID))
		}
	}
}

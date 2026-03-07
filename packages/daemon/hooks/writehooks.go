package hooks

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/tasksquad/daemon/logger"
)

func WriteHooks(workDir string, port int) {
	claudeDir := filepath.Join(workDir, ".claude")
	settingsPath := filepath.Join(claudeDir, "settings.json")

	if err := os.MkdirAll(claudeDir, 0755); err != nil {
		logger.Warn(fmt.Sprintf("Could not create .claude directory: %v", err))
		return
	}

	existing := make(map[string]any)
	if data, err := os.ReadFile(settingsPath); err == nil {
		json.Unmarshal(data, &existing)
	}

	hooks := map[string]any{
		"Stop": []any{
			map[string]any{
				"matcher": "",
				"hooks": []any{
					map[string]any{
						"type":    "command",
						"command": fmt.Sprintf("curl -s -X POST http://localhost:%d/hooks/stop -H 'Content-Type: application/json' -d @-", port),
					},
				},
			},
		},
		"Notification": []any{
			map[string]any{
				"matcher": "",
				"hooks": []any{
					map[string]any{
						"type":    "command",
						"command": fmt.Sprintf("curl -s -X POST http://localhost:%d/hooks/notification -H 'Content-Type: application/json' -d @-", port),
					},
				},
			},
		},
	}

	existing["hooks"] = hooks

	if data, err := json.MarshalIndent(existing, "", "  "); err == nil {
		os.WriteFile(settingsPath, data, 0644)
	}
}

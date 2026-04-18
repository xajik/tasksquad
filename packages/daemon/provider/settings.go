package provider

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// writeHooks reads settingsPath (creating the parent dir and file if needed),
// merges the given hooks into the "hooks" key, and writes the result back.
func writeHooks(settingsPath string, hooks map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0755); err != nil {
		return err
	}
	existing := make(map[string]any)
	if data, err := os.ReadFile(settingsPath); err == nil {
		_ = json.Unmarshal(data, &existing)
	}
	existing["hooks"] = hooks
	data, err := json.MarshalIndent(existing, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal settings: %w", err)
	}
	if err := os.WriteFile(settingsPath, data, 0644); err != nil {
		return fmt.Errorf("write settings: %w", err)
	}
	return nil
}

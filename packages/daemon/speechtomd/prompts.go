package speechtomd

import (
	"os"
	"path/filepath"
	"strings"
)

// PromptEntry is a named custom prompt stored on disk.
type PromptEntry struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

func promptsDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".tsq", "prompts")
	return dir, os.MkdirAll(dir, 0755)
}

// ListPrompts returns all saved prompts from $HOME/.tsq/prompts/.
func ListPrompts() ([]PromptEntry, error) {
	dir, err := promptsDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var prompts []PromptEntry
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		prompts = append(prompts, PromptEntry{
			Name:    strings.TrimSuffix(e.Name(), ".md"),
			Content: string(data),
		})
	}
	return prompts, nil
}

// SavePrompt writes content to $HOME/.tsq/prompts/{name}.md.
func SavePrompt(name, content string) error {
	dir, err := promptsDir()
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name+".md"), []byte(content), 0644)
}

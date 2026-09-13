package harness

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/BurntSushi/toml"
)

const codexManaged = "# Managed by TaskSquad; edits are replaced on sync.\n"
const commandManaged = "<!-- Managed by TaskSquad command sync. -->"

var safeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

// InstallCodexAgent renders the server's Markdown definition as a native Codex
// agent. Never overwrite an independently authored file with the same name.
func InstallCodexAgent(workDir, name, description, content string) error {
	if !safeName.MatchString(name) {
		return fmt.Errorf("invalid agent name %q", name)
	}
	var b bytes.Buffer
	b.WriteString(codexManaged)
	if description == "" {
		description = name
	}
	body := StripFrontmatter(content)
	if err := toml.NewEncoder(&b).Encode(struct {
		Name         string `toml:"name"`
		Description  string `toml:"description"`
		Instructions string `toml:"developer_instructions"`
	}{name, description, body}); err != nil {
		return err
	}
	return writeManaged(filepath.Join(workDir, ".codex", "agents", name+".toml"), b.Bytes(), codexManaged)
}

func RemoveCodexAgent(workDir, name string) {
	if safeName.MatchString(name) {
		removeManaged(filepath.Join(workDir, ".codex", "agents", name+".toml"), codexManaged)
	}
}

// Codex discovers skills in .agents/skills; it has no .agents/commands loader.
// A distinct prefix prevents a command from overwriting a same-named skill.
func InstallCodexCommand(workDir, name, content string) error {
	if !safeName.MatchString(name) {
		return fmt.Errorf("invalid command name %q", name)
	}
	skillName := "source-command-" + name
	body := fmt.Sprintf("---\nname: %s\ndescription: Run the TaskSquad %s command.\n---\n%s\n\n%s\n", skillName, name, commandManaged, StripFrontmatter(content))
	return writeManaged(filepath.Join(workDir, ".agents", "skills", skillName, "SKILL.md"), []byte(body), commandManaged)
}

func RemoveCodexCommand(workDir, name string) {
	if safeName.MatchString(name) {
		removeManaged(filepath.Join(workDir, ".agents", "skills", "source-command-"+name, "SKILL.md"), commandManaged)
	}
}

func StripFrontmatter(content string) string {
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	if strings.HasPrefix(normalized, "---\n") {
		if end := strings.Index(normalized[4:], "\n---\n"); end >= 0 {
			return strings.TrimSpace(normalized[4+end+5:])
		}
	}
	return content
}

func writeManaged(path string, data []byte, marker string) error {
	old, err := os.ReadFile(path)
	if err == nil && !bytes.Contains(old, []byte(marker)) {
		return nil
	}
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	// Replace atomically so a simultaneously starting CLI sees a complete file.
	f, err := os.CreateTemp(filepath.Dir(path), ".tsq-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func removeManaged(path, marker string) {
	if data, err := os.ReadFile(path); err == nil && bytes.Contains(data, []byte(marker)) {
		os.Remove(path)
	}
}

// InstallCodexSkill preserves an independently authored same-name skill. The
// marker follows YAML frontmatter, keeping Codex discovery metadata intact.
func InstallCodexSkill(workDir, name, content string) error {
	if !safeName.MatchString(name) {
		return fmt.Errorf("invalid skill name %q", name)
	}
	marker := "<!-- Managed by TaskSquad skill sync. -->"
	body := content
	if strings.HasPrefix(content, "---\n") {
		if end := strings.Index(content[4:], "\n---\n"); end >= 0 {
			pos := 4 + end + 5
			body = content[:pos] + marker + "\n" + content[pos:]
		} else {
			return fmt.Errorf("invalid skill frontmatter for %s", name)
		}
	} else {
		body = marker + "\n" + content
	}
	return writeManaged(filepath.Join(workDir, ".agents", "skills", name, "SKILL.md"), []byte(body), marker)
}

func RemoveCodexSkill(workDir, name string) {
	if safeName.MatchString(name) {
		removeManaged(filepath.Join(workDir, ".agents", "skills", name, "SKILL.md"), "<!-- Managed by TaskSquad skill sync. -->")
	}
}

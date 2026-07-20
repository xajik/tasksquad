package kb

import (
	"os"
	"path/filepath"
	"testing"
)

// ── Search ──────────────────────────────────────────────────────────────────

func TestSearch_NoKBDirectory(t *testing.T) {
	workDir := t.TempDir()

	entries, err := Search(workDir, "anything")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if entries != nil {
		t.Errorf("expected nil entries, got %v", entries)
	}
}

func TestSearch_EmptyKBDirectory(t *testing.T) {
	workDir := t.TempDir()
	mustMkdir(t, filepath.Join(workDir, "tsq", "kb"))

	entries, err := Search(workDir, "anything")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected 0 entries for an empty kb dir, got %d", len(entries))
	}
}

func TestSearch_OneEntry(t *testing.T) {
	workDir := t.TempDir()
	mustWriteKBFile(t, workDir, "packages/daemon/supervisor.md", "Supervisor", []string{"go", "tmux"},
		"Watches agents for inactivity and spawns a health-check session.")

	entries, err := Search(workDir, "")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Title != "Supervisor" {
		t.Errorf("Title = %q, want Supervisor", entries[0].Title)
	}
}

func TestSearch_KeywordMatchTitleTagsAndBody(t *testing.T) {
	workDir := t.TempDir()
	mustWriteKBFile(t, workDir, "packages/daemon/kb.md", "Knowledge base package", []string{"search"},
		"Pure local search over tsq/kb markdown files.")
	mustWriteKBFile(t, workDir, "packages/daemon/tmux.md", "tmux helpers", []string{"sessions"},
		"Wraps the tmux CLI for session lifecycle.")

	byTitle, err := Search(workDir, "knowledge")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(byTitle) != 1 || byTitle[0].Title != "Knowledge base package" {
		t.Errorf("expected 1 match for 'knowledge', got %+v", byTitle)
	}

	byTag, err := Search(workDir, "sessions")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(byTag) != 1 || byTag[0].Title != "tmux helpers" {
		t.Errorf("expected 1 match for tag 'sessions', got %+v", byTag)
	}

	byBody, err := Search(workDir, "lifecycle")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(byBody) != 1 || byBody[0].Title != "tmux helpers" {
		t.Errorf("expected 1 match for body 'lifecycle', got %+v", byBody)
	}
}

func TestSearch_FrontmatterParsed(t *testing.T) {
	workDir := t.TempDir()
	dir := filepath.Join(workDir, "tsq", "kb", "packages", "daemon")
	mustMkdir(t, dir)
	content := "---\ntitle: Config package\ntags: config, toml\n---\n\nLoads and watches config.toml."
	if err := os.WriteFile(filepath.Join(dir, "config.md"), []byte(content), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	entries, err := Search(workDir, "")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	e := entries[0]
	if e.Title != "Config package" {
		t.Errorf("Title = %q, want %q", e.Title, "Config package")
	}
	if len(e.Tags) != 2 || e.Tags[0] != "config" || e.Tags[1] != "toml" {
		t.Errorf("Tags = %v, want [config toml]", e.Tags)
	}
	if e.Excerpt != "Loads and watches config.toml." {
		t.Errorf("Excerpt = %q, want %q", e.Excerpt, "Loads and watches config.toml.")
	}
}

func TestSearch_NoFrontmatterFallsBackToFilename(t *testing.T) {
	workDir := t.TempDir()
	dir := filepath.Join(workDir, "tsq", "kb")
	mustMkdir(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "orphan-notes.md"), []byte("just plain notes, no frontmatter"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	entries, err := Search(workDir, "plain notes")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Title != "orphan-notes" {
		t.Errorf("Title = %q, want filename-derived %q", entries[0].Title, "orphan-notes")
	}
}

func TestSearch_NoMatchReturnsEmpty(t *testing.T) {
	workDir := t.TempDir()
	mustWriteKBFile(t, workDir, "a.md", "One", nil, "body one")

	entries, err := Search(workDir, "nonexistent-keyword")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected 0 entries, got %d", len(entries))
	}
}

func TestSearch_CaseInsensitive(t *testing.T) {
	workDir := t.TempDir()
	mustWriteKBFile(t, workDir, "a.md", "Repo layout", nil, "Packages live under packages/.")

	entries, err := Search(workDir, "REPO")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 case-insensitive match, got %d", len(entries))
	}
}

// ── Exists ──────────────────────────────────────────────────────────────────

func TestExists_FalseWhenMissing(t *testing.T) {
	workDir := t.TempDir()
	if Exists(workDir) {
		t.Error("expected Exists to be false when tsq/kb doesn't exist")
	}
}

func TestExists_FalseWhenEmptyDirectory(t *testing.T) {
	workDir := t.TempDir()
	mustMkdir(t, filepath.Join(workDir, "tsq", "kb"))

	if Exists(workDir) {
		t.Error("expected Exists to be false for an empty tsq/kb directory")
	}
}

func TestExists_TrueAfterWrite(t *testing.T) {
	workDir := t.TempDir()
	mustWriteKBFile(t, workDir, "packages/daemon/kb.md", "Knowledge base package", nil, "body")

	if !Exists(workDir) {
		t.Error("expected Exists to be true after writing a KB markdown file")
	}
}

func TestExists_TrueForNestedFile(t *testing.T) {
	workDir := t.TempDir()
	mustWriteKBFile(t, workDir, "a/b/c/deep.md", "Deep", nil, "body")

	if !Exists(workDir) {
		t.Error("expected Exists to be true for a file nested several directories deep")
	}
}

func TestExists_FalseForNonMarkdownFiles(t *testing.T) {
	workDir := t.TempDir()
	dir := filepath.Join(workDir, "tsq", "kb")
	mustMkdir(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("not markdown"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	if Exists(workDir) {
		t.Error("expected Exists to be false when the only file present isn't markdown")
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

func mustMkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir %q: %v", dir, err)
	}
}

// mustWriteKBFile writes <workDir>/tsq/kb/<relPath> with frontmatter built
// from title/tags, creating parent directories as needed.
func mustWriteKBFile(t *testing.T, workDir, relPath, title string, tags []string, body string) {
	t.Helper()
	path := filepath.Join(workDir, "tsq", "kb", relPath)
	mustMkdir(t, filepath.Dir(path))

	var content string
	if title != "" {
		tagLine := ""
		if len(tags) > 0 {
			joined := ""
			for i, tag := range tags {
				if i > 0 {
					joined += ", "
				}
				joined += tag
			}
			tagLine = "tags: " + joined + "\n"
		}
		content = "---\ntitle: " + title + "\n" + tagLine + "---\n\n" + body
	} else {
		content = body
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write %q: %v", path, err)
	}
}

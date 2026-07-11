package memory

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ── WriteLocal ──────────────────────────────────────────────────────────────

func TestWriteLocal_CreatesFileWithFrontmatter(t *testing.T) {
	workDir := t.TempDir()

	path, err := WriteLocal(workDir, CategoryArchitecture, "Chose SQLite for local cache", "We picked SQLite over BoltDB because...", []string{"db", "cache"})
	if err != nil {
		t.Fatalf("WriteLocal: %v", err)
	}

	wantDir := filepath.Join(workDir, ".tsq", "memory", "architecture")
	if filepath.Dir(path) != wantDir {
		t.Errorf("path dir = %q, want %q", filepath.Dir(path), wantDir)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading written file: %v", err)
	}
	content := string(data)

	for _, want := range []string{
		"---\n",
		"title: Chose SQLite for local cache\n",
		"category: architecture\n",
		"tags: db, cache\n",
		"We picked SQLite over BoltDB because...",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("file content missing %q\ngot:\n%s", want, content)
		}
	}
}

func TestWriteLocal_FilenameHasDateAndSlug(t *testing.T) {
	workDir := t.TempDir()

	path, err := WriteLocal(workDir, CategoryEvents, "Migrated to D1!", "content", nil)
	if err != nil {
		t.Fatalf("WriteLocal: %v", err)
	}

	name := filepath.Base(path)
	if !strings.HasSuffix(name, "-migrated-to-d1.md") {
		t.Errorf("filename = %q, want suffix -migrated-to-d1.md", name)
	}
}

func TestWriteLocal_CollisionAppendsSuffix(t *testing.T) {
	workDir := t.TempDir()

	first, err := WriteLocal(workDir, CategoryEvents, "Same Title", "first", nil)
	if err != nil {
		t.Fatalf("first WriteLocal: %v", err)
	}
	second, err := WriteLocal(workDir, CategoryEvents, "Same Title", "second", nil)
	if err != nil {
		t.Fatalf("second WriteLocal: %v", err)
	}

	if first == second {
		t.Fatalf("expected distinct paths, both are %q", first)
	}

	firstData, _ := os.ReadFile(first)
	secondData, _ := os.ReadFile(second)
	if !strings.Contains(string(firstData), "first") {
		t.Errorf("first file should still contain original content, got:\n%s", firstData)
	}
	if !strings.Contains(string(secondData), "second") {
		t.Errorf("second file should contain its own content, got:\n%s", secondData)
	}
}

func TestWriteLocal_CreatesDirectories(t *testing.T) {
	workDir := t.TempDir()

	if _, err := WriteLocal(workDir, CategoryPersonal, "t", "c", nil); err != nil {
		t.Fatalf("WriteLocal: %v", err)
	}

	info, err := os.Stat(filepath.Join(workDir, ".tsq", "memory", "personal"))
	if err != nil || !info.IsDir() {
		t.Fatalf("expected category directory to exist: %v", err)
	}
}

func TestWriteLocal_RequiresWorkDirCategoryTitle(t *testing.T) {
	cases := []struct {
		name, workDir, category, title string
	}{
		{"missing workDir", "", "events", "t"},
		{"missing category", "/tmp", "", "t"},
		{"missing title", "/tmp", "events", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := WriteLocal(c.workDir, c.category, c.title, "content", nil); err == nil {
				t.Errorf("expected error for %s", c.name)
			}
		})
	}
}

// ── SearchLocal ─────────────────────────────────────────────────────────────

func TestSearchLocal_NoMemoryDirectory(t *testing.T) {
	workDir := t.TempDir()

	entries, err := SearchLocal(workDir, "anything")
	if err != nil {
		t.Fatalf("SearchLocal: %v", err)
	}
	if entries != nil {
		t.Errorf("expected nil entries, got %v", entries)
	}
}

func TestSearchLocal_MatchesTitleTagsAndBody(t *testing.T) {
	workDir := t.TempDir()

	mustWrite(t, workDir, CategoryArchitecture, "Switched to SQLite", "We use SQLite for the local cache now.", []string{"database"})
	mustWrite(t, workDir, CategoryPreferences, "Prefers tabs", "The team prefers tabs over spaces.", []string{"style"})
	mustWrite(t, workDir, CategoryEvents, "Unrelated entry", "Nothing to do with storage.", []string{"misc"})

	byTitle, err := SearchLocal(workDir, "sqlite")
	if err != nil {
		t.Fatalf("SearchLocal (title/body match): %v", err)
	}
	if len(byTitle) != 1 || byTitle[0].Title != "Switched to SQLite" {
		t.Errorf("expected 1 match for 'sqlite', got %+v", byTitle)
	}

	byTag, err := SearchLocal(workDir, "style")
	if err != nil {
		t.Fatalf("SearchLocal (tag match): %v", err)
	}
	if len(byTag) != 1 || byTag[0].Title != "Prefers tabs" {
		t.Errorf("expected 1 match for tag 'style', got %+v", byTag)
	}

	byBody, err := SearchLocal(workDir, "storage")
	if err != nil {
		t.Fatalf("SearchLocal (body match): %v", err)
	}
	if len(byBody) != 1 || byBody[0].Title != "Unrelated entry" {
		t.Errorf("expected 1 match for 'storage', got %+v", byBody)
	}
}

func TestSearchLocal_CaseInsensitive(t *testing.T) {
	workDir := t.TempDir()
	mustWrite(t, workDir, CategoryStructure, "Repo layout", "Packages live under packages/.", nil)

	entries, err := SearchLocal(workDir, "REPO")
	if err != nil {
		t.Fatalf("SearchLocal: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 case-insensitive match, got %d", len(entries))
	}
}

func TestSearchLocal_EmptyQueryReturnsAll(t *testing.T) {
	workDir := t.TempDir()
	mustWrite(t, workDir, CategoryEvents, "One", "body one", nil)
	mustWrite(t, workDir, CategoryPersonal, "Two", "body two", nil)

	entries, err := SearchLocal(workDir, "")
	if err != nil {
		t.Fatalf("SearchLocal: %v", err)
	}
	if len(entries) != 2 {
		t.Errorf("expected 2 entries for empty query, got %d", len(entries))
	}
}

func TestSearchLocal_NoMatchReturnsEmpty(t *testing.T) {
	workDir := t.TempDir()
	mustWrite(t, workDir, CategoryEvents, "One", "body one", nil)

	entries, err := SearchLocal(workDir, "nonexistent-keyword")
	if err != nil {
		t.Fatalf("SearchLocal: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected 0 entries, got %d", len(entries))
	}
}

func TestSearchLocal_CategoryFallsBackToDirectory(t *testing.T) {
	workDir := t.TempDir()
	dir := filepath.Join(workDir, ".tsq", "memory", "structure")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// No frontmatter at all — category must be inferred from the directory.
	if err := os.WriteFile(filepath.Join(dir, "2026-01-01-plain.md"), []byte("just some plain notes about the repo"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	entries, err := SearchLocal(workDir, "plain notes")
	if err != nil {
		t.Fatalf("SearchLocal: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Category != "structure" {
		t.Errorf("category = %q, want structure", entries[0].Category)
	}
}

// ── slug ────────────────────────────────────────────────────────────────────

func TestSlug(t *testing.T) {
	cases := map[string]string{
		"Chose SQLite for local cache": "chose-sqlite-for-local-cache",
		"Migrated to D1!":              "migrated-to-d1",
		"  leading/trailing  ":         "leading-trailing",
		"":                             "untitled",
		"***":                          "untitled",
	}
	for in, want := range cases {
		if got := slug(in); got != want {
			t.Errorf("slug(%q) = %q, want %q", in, got, want)
		}
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

func mustWrite(t *testing.T, workDir, category, title, content string, tags []string) {
	t.Helper()
	if _, err := WriteLocal(workDir, category, title, content, tags); err != nil {
		t.Fatalf("WriteLocal(%q): %v", title, err)
	}
}

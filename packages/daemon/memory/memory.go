// Package memory implements local-scope agentic memory: markdown notes an
// agent writes about a project (facts, decisions, conventions) that live
// entirely on disk under the work_dir, gitignored, with no server presence.
//
// This mirrors the existing .tsq/skills, .tsq/agents, .tsq/commands
// convention (see packages/daemon/skills/install.go) but for freeform notes
// rather than installed tool configuration. Global-scope memory (pushed to
// the worker's D1 database) is handled by packages/daemon/cmd/memory instead
// — this package only ever touches the local filesystem.
package memory

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// The five long-term memory categories a close-session skill chooses between.
const (
	CategoryPersonal     = "personal"
	CategoryPreferences  = "preferences"
	CategoryStructure    = "structure"
	CategoryArchitecture = "architecture"
	CategoryEvents       = "events"
)

// excerptRadius is how many characters of context SearchLocal keeps on each
// side of a query match when building an Entry's Excerpt.
const excerptRadius = 80

// Entry is one memory item surfaced by a search, whether read from a local
// markdown file (Scope "local") or returned by the global search API
// (Scope "global", populated by the cmd/memory CLI layer, not this package).
type Entry struct {
	Scope    string
	Category string
	Title    string
	Path     string // local only; empty for global entries
	Tags     []string
	Excerpt  string
}

// WriteLocal writes a memory entry as a markdown file with YAML frontmatter
// to <workDir>/.tsq/memory/<category>/<YYYY-MM-DD>-<slug-of-title>.md,
// creating directories as needed. If a file for the same day and slug already
// exists, a numeric suffix is appended rather than silently overwriting it.
// Returns the path written.
func WriteLocal(workDir, category, title, content string, tags []string) (string, error) {
	if workDir == "" {
		return "", fmt.Errorf("memory: workDir is required")
	}
	if category == "" {
		return "", fmt.Errorf("memory: category is required")
	}
	if title == "" {
		return "", fmt.Errorf("memory: title is required")
	}

	dir := filepath.Join(workDir, ".tsq", "memory", category)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}

	date := time.Now().Format("2006-01-02")
	path := uniquePath(dir, date, slug(title))

	var sb strings.Builder
	sb.WriteString("---\n")
	fmt.Fprintf(&sb, "title: %s\n", title)
	fmt.Fprintf(&sb, "category: %s\n", category)
	fmt.Fprintf(&sb, "date: %s\n", date)
	fmt.Fprintf(&sb, "tags: %s\n", strings.Join(tags, ", "))
	sb.WriteString("---\n\n")
	sb.WriteString(strings.TrimRight(content, "\n"))
	sb.WriteString("\n")

	if err := os.WriteFile(path, []byte(sb.String()), 0644); err != nil {
		return "", err
	}
	return path, nil
}

// SearchLocal walks <workDir>/.tsq/memory/**/*.md and returns entries whose
// title, tags, or body case-insensitively contain query. An empty query
// matches every entry. This is a deliberately simple keyword search (v1, no
// embeddings) — local memory bases are expected to stay small since they're
// scoped to one machine's work_dir. Returns (nil, nil), not an error, when
// the memory directory doesn't exist yet (nothing has been written locally).
func SearchLocal(workDir, query string) ([]Entry, error) {
	root := filepath.Join(workDir, ".tsq", "memory")
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return nil, nil
	}

	q := strings.ToLower(strings.TrimSpace(query))
	var entries []Entry

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil // skip unreadable files rather than failing the whole search
		}
		if entry, ok := matchLocalEntry(root, path, string(data), q); ok {
			entries = append(entries, entry)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	return entries, nil
}

// matchLocalEntry parses one memory file's frontmatter and body, and reports
// whether it matches q.
func matchLocalEntry(root, path, raw, q string) (Entry, bool) {
	title, category, tags, body := parseFrontmatter(raw)
	if category == "" {
		category = categoryFromPath(root, path)
	}

	haystack := strings.ToLower(title + " " + strings.Join(tags, " ") + " " + body)
	if q != "" && !strings.Contains(haystack, q) {
		return Entry{}, false
	}

	return Entry{
		Scope:    "local",
		Category: category,
		Title:    title,
		Path:     path,
		Tags:     tags,
		Excerpt:  excerpt(body, q),
	}, true
}

// categoryFromPath falls back to the enclosing directory name — which is
// always the category, per WriteLocal's layout — when a file has no (or a
// malformed) frontmatter category field.
func categoryFromPath(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return ""
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) > 1 {
		return parts[0]
	}
	return ""
}

// parseFrontmatter extracts title/category/tags from a leading
// "---\nkey: value\n...\n---" header and returns the trimmed remainder as
// body. A missing or malformed header yields empty metadata with the whole
// file treated as body text — callers fall back to categoryFromPath in that
// case, so a stray file without frontmatter still gets a best-effort category.
func parseFrontmatter(raw string) (title, category string, tags []string, body string) {
	body = raw
	lines := strings.Split(raw, "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			end = i
			break
		}
	}
	if end == -1 {
		return
	}
	for _, line := range lines[1:end] {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		switch key {
		case "title":
			title = value
		case "category":
			category = value
		case "tags":
			tags = SplitTags(value)
		}
	}
	body = strings.TrimSpace(strings.Join(lines[end+1:], "\n"))
	return
}

// SplitTags parses a comma-separated tag list (as accepted by --tags on the
// CLI and written into frontmatter) into a trimmed, non-empty slice.
func SplitTags(value string) []string {
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	tags := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			tags = append(tags, t)
		}
	}
	return tags
}

// excerpt returns a short snippet of body around the first match of q, or
// the start of body when q is empty or the match came from the title/tags
// rather than the body itself.
func excerpt(body, q string) string {
	body = strings.TrimSpace(body)
	if q != "" {
		if idx := strings.Index(strings.ToLower(body), q); idx >= 0 {
			start := max(idx-excerptRadius, 0)
			end := min(idx+len(q)+excerptRadius, len(body))
			snippet := strings.TrimSpace(body[start:end])
			if start > 0 {
				snippet = "…" + snippet
			}
			if end < len(body) {
				snippet += "…"
			}
			return snippet
		}
	}
	if len(body) > 2*excerptRadius {
		return strings.TrimSpace(body[:2*excerptRadius]) + "…"
	}
	return body
}

var slugNonAlnumRe = regexp.MustCompile(`[^a-z0-9]+`)

// slug lowercases title, collapses runs of non-alphanumeric characters into a
// single hyphen, and trims leading/trailing hyphens.
func slug(title string) string {
	s := slugNonAlnumRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(title)), "-")
	s = strings.Trim(s, "-")
	if s == "" {
		s = "untitled"
	}
	return s
}

// uniquePath returns dir/date-slug.md, or dir/date-slug-2.md, -3.md, ... if
// that file already exists.
func uniquePath(dir, date, s string) string {
	base := date + "-" + s
	path := filepath.Join(dir, base+".md")
	for i := 2; fileExists(path); i++ {
		path = filepath.Join(dir, fmt.Sprintf("%s-%d.md", base, i))
	}
	return path
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

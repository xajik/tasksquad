// Package kb implements local search over a project's git-tracked knowledge
// base: one short markdown file per package/module under
// <work_dir>/tsq/kb/**/*.md, written by the tsq-kb-builder and tsq-dreaming
// skills (see the dreamer package). Unlike packages/daemon/memory — gitignored
// and scoped to one machine's .tsq/ tree — tsq/kb/ is committed content meant
// to be read by any teammate or agent that checks out the repo, so this
// package only ever reads it; nothing here writes to tsq/kb/.
package kb

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// excerptRadius is how many characters of context Search keeps on each side
// of a query match when building an Entry's Excerpt.
const excerptRadius = 80

// Entry is one knowledge-base file surfaced by a search.
type Entry struct {
	Path    string
	Title   string
	Tags    []string
	Excerpt string
}

// Search walks <workDir>/tsq/kb/**/*.md and returns entries whose title,
// tags, or body case-insensitively contain query. An empty query matches
// every entry. This mirrors memory.SearchLocal's deliberately simple keyword
// search (v1, no embeddings). Returns (nil, nil), not an error, when tsq/kb
// doesn't exist yet (nothing has been bootstrapped via `tsq kb init`).
func Search(workDir, query string) ([]Entry, error) {
	root := filepath.Join(workDir, "tsq", "kb")
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
		if entry, ok := matchEntry(path, string(data), q); ok {
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

// Exists reports whether workDir has a bootstrapped knowledge base — tsq/kb
// exists and contains at least one markdown file. A directory that exists but
// is empty (or not-yet-created) reports false, since both prompt injection
// (agent/lifecycle.go) and Dreaming eligibility (dreamer package) need to
// distinguish "no KB yet" from "KB present" — Dreaming never auto-bootstraps,
// only `tsq kb init` does.
func Exists(workDir string) bool {
	root := filepath.Join(workDir, "tsq", "kb")
	found := false
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return filepath.SkipAll // missing/unreadable root: treat as "not found"
		}
		if !d.IsDir() && strings.HasSuffix(d.Name(), ".md") {
			found = true
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

// matchEntry parses one KB file's frontmatter and body, and reports whether
// it matches q.
func matchEntry(path, raw, q string) (Entry, bool) {
	title, tags, body := parseFrontmatter(raw)
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(path), ".md")
	}

	haystack := strings.ToLower(title + " " + strings.Join(tags, " ") + " " + body)
	if q != "" && !strings.Contains(haystack, q) {
		return Entry{}, false
	}

	return Entry{
		Path:    path,
		Title:   title,
		Tags:    tags,
		Excerpt: excerpt(body, q),
	}, true
}

// parseFrontmatter extracts title/tags from a leading
// "---\nkey: value\n...\n---" header and returns the trimmed remainder as
// body. A missing or malformed header yields empty metadata with the whole
// file treated as body text — matchEntry falls back to the filename for
// title in that case.
func parseFrontmatter(raw string) (title string, tags []string, body string) {
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
		case "tags":
			tags = splitTags(value)
		}
	}
	body = strings.TrimSpace(strings.Join(lines[end+1:], "\n"))
	return
}

// splitTags parses a comma-separated tag list (as written into frontmatter)
// into a trimmed, non-empty slice.
func splitTags(value string) []string {
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

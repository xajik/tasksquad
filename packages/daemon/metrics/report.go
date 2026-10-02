// Package metrics builds the per-session usage report posted to
// POST /daemon/session/metrics for the analytics dashboard. It only ever
// produces counts (tool and skill names, token totals, turns, duration,
// model) — never prompt or message content. Mirrors the native macOS
// engine's SessionReport.swift.
package metrics

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Report is one session's aggregate usage.
type Report struct {
	Provider         string
	Model            string
	DurationMs       int64
	Turns            int
	InputTokens      int64
	OutputTokens     int64
	CacheReadTokens  int64
	CacheWriteTokens int64
	ToolErrors       int
	Tools            map[string]int
	Skills           map[string]int
}

// New returns an empty report for provider.
func New(provider string) *Report {
	return &Report{Provider: provider, Tools: map[string]int{}, Skills: map[string]int{}}
}

func (r *Report) addTool(name string) {
	if name != "" {
		r.Tools[name]++
	}
}

// AddSkill counts one skill invocation.
func (r *Report) AddSkill(name string) {
	if name != "" {
		r.Skills[name]++
	}
}

// ToolCalls is the total number of tool invocations.
func (r *Report) ToolCalls() int {
	n := 0
	for _, c := range r.Tools {
		n += c
	}
	return n
}

// Body is the JSON payload for /daemon/session/metrics.
func (r *Report) Body(sessionID string) map[string]any {
	return map[string]any{
		"session_id": sessionID, "provider": r.Provider, "model": r.Model,
		"duration_ms": r.DurationMs, "turns": r.Turns,
		"tokens": map[string]any{"input": r.InputTokens, "output": r.OutputTokens,
			"cache_read": r.CacheReadTokens, "cache_write": r.CacheWriteTokens},
		"tool_calls": r.ToolCalls(), "tool_errors": r.ToolErrors,
		"tools": r.Tools, "skills": r.Skills,
	}
}

var skillToken = regexp.MustCompile(`(?:^|\s)[/$](tsq-[A-Za-z0-9_-]+)`)

// Skills returns TaskSquad skill invocations (/tsq-x, or $tsq-x for Codex) in text the daemon typed.
func Skills(text string) []string {
	var out []string
	for _, m := range skillToken.FindAllStringSubmatch(text, -1) {
		out = append(out, m[1])
	}
	return out
}

func num(v any) int64 {
	f, _ := v.(float64)
	return int64(f)
}

func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// Claude parses a Claude Code transcript. Streaming writes each assistant
// message several times, so usage is counted once per message id.
func Claude(lines []string, r *Report) {
	seenUsage, seenTools := map[string]bool{}, map[string]bool{}
	for _, line := range lines {
		var o map[string]any
		if json.Unmarshal([]byte(line), &o) != nil {
			continue
		}
		msg := obj(o["message"])
		if msg == nil {
			continue
		}
		if model, _ := msg["model"].(string); model != "" && !strings.HasPrefix(model, "<") {
			r.Model = model
		}
		id, _ := msg["id"].(string)
		if usage := obj(msg["usage"]); usage != nil && (id == "" || !seenUsage[id]) {
			seenUsage[id] = id != ""
			r.InputTokens += num(usage["input_tokens"])
			r.OutputTokens += num(usage["output_tokens"])
			r.CacheReadTokens += num(usage["cache_read_input_tokens"])
			r.CacheWriteTokens += num(usage["cache_creation_input_tokens"])
		}
		blocks, _ := msg["content"].([]any)
		for _, b := range blocks {
			block := obj(b)
			switch block["type"] {
			case "tool_use":
				toolID, _ := block["id"].(string)
				if toolID != "" && seenTools[toolID] {
					continue
				}
				seenTools[toolID] = toolID != ""
				name, _ := block["name"].(string)
				r.addTool(name)
				if name == "Skill" {
					input := obj(block["input"])
					skill, _ := input["skill"].(string)
					if skill == "" {
						skill, _ = input["name"].(string)
					}
					r.AddSkill(skill)
				}
			case "tool_result":
				if block["is_error"] == true {
					r.ToolErrors++
				}
			}
		}
	}
}

var codexToolItems = map[string]bool{"function_call": true, "custom_tool_call": true, "local_shell_call": true,
	"web_search_call": true, "tool_search_call": true}

// Codex parses a Codex rollout (~/.codex/sessions/.../rollout-*-<thread>.jsonl).
// token_count totals are cumulative for the thread; the last one wins.
func Codex(lines []string, r *Report) {
	var totals map[string]any
	for _, line := range lines {
		var o map[string]any
		if json.Unmarshal([]byte(line), &o) != nil {
			continue
		}
		payload := obj(o["payload"])
		kind, _ := payload["type"].(string)
		switch {
		case o["type"] == "turn_context":
			if model, _ := payload["model"].(string); model != "" {
				r.Model = model
			}
		case o["type"] == "response_item" && codexToolItems[kind]:
			name, _ := payload["name"].(string)
			if name == "" {
				name = kind
				if kind == "local_shell_call" {
					name = "shell"
				}
			}
			r.addTool(name)
		case o["type"] == "event_msg" && kind == "token_count":
			if t := obj(obj(payload["info"])["total_token_usage"]); t != nil {
				totals = t
			}
		case o["type"] == "event_msg" && kind == "item_completed":
			if obj(payload["item"])["status"] == "failed" {
				r.ToolErrors++
			}
		}
	}
	if totals != nil {
		cached := num(totals["cached_input_tokens"])
		r.InputTokens = max(num(totals["input_tokens"])-cached, 0)
		r.CacheReadTokens = cached
		r.CacheWriteTokens = num(totals["cache_write_input_tokens"])
		r.OutputTokens = num(totals["output_tokens"]) + num(totals["reasoning_output_tokens"])
	}
}

var genericToolTypes = map[string]bool{"tool_use": true, "tool_call": true, "toolCall": true, "function_call": true, "tool-call": true}

// Generic scans any JSON value (Gemini, Pi, …) for tool calls and token counts.
func Generic(v any, r *Report) {
	switch t := v.(type) {
	case []any:
		for _, item := range t {
			Generic(item, r)
		}
	case map[string]any:
		if typ, _ := t["type"].(string); genericToolTypes[typ] {
			name, _ := t["name"].(string)
			if name == "" {
				name, _ = t["toolName"].(string)
			}
			r.addTool(name)
		}
		for _, key := range []string{"functionCall", "toolCall"} {
			if call := obj(t[key]); call != nil {
				name, _ := call["name"].(string)
				r.addTool(name)
			}
		}
		if r.Model == "" {
			if model, _ := t["model"].(string); model != "" {
				r.Model = model
			} else if model, _ := t["modelId"].(string); model != "" {
				r.Model = model
			}
		}
		for _, key := range []string{"usage", "usageMetadata", "tokens"} {
			if u := obj(t[key]); u != nil {
				r.InputTokens += num(u["input_tokens"]) + num(u["input"]) + num(u["promptTokenCount"]) + num(u["prompt_tokens"])
				r.OutputTokens += num(u["output_tokens"]) + num(u["output"]) + num(u["candidatesTokenCount"]) + num(u["completion_tokens"])
				r.CacheReadTokens += num(u["cache_read_input_tokens"]) + num(u["cacheRead"]) + num(u["cachedContentTokenCount"])
			}
		}
		for key, child := range t {
			if key != "usage" && key != "usageMetadata" && key != "tokens" {
				Generic(child, r)
			}
		}
	}
}

// Transcript locates the session's transcript, or "" when the harness keeps none we know.
func Transcript(provider, workDir, hookTranscript, codexThread string, since time.Time, home string) string {
	if hookTranscript != "" {
		if _, err := os.Stat(hookTranscript); err == nil {
			return hookTranscript
		}
	}
	newest := func(dir string, recursive bool, match func(string) bool) string {
		best, bestTime := "", since.Add(-5*time.Second)
		walk := func(path string, info os.FileInfo) {
			if info.IsDir() || !match(filepath.Base(path)) || info.ModTime().Before(bestTime) {
				return
			}
			best, bestTime = path, info.ModTime()
		}
		if recursive {
			filepath.Walk(dir, func(p string, info os.FileInfo, err error) error { //nolint:errcheck
				if err == nil {
					walk(p, info)
				}
				return nil
			})
		} else if entries, err := os.ReadDir(dir); err == nil {
			for _, e := range entries {
				if info, err := e.Info(); err == nil {
					walk(filepath.Join(dir, e.Name()), info)
				}
			}
		}
		return best
	}
	switch provider {
	case "codex":
		if codexThread == "" {
			return ""
		}
		return newest(filepath.Join(home, ".codex", "sessions"), true, func(name string) bool {
			return strings.HasPrefix(name, "rollout-") && strings.HasSuffix(name, codexThread+".jsonl")
		})
	case "pi":
		folder := "--" + strings.ReplaceAll(strings.Trim(workDir, "/"), "/", "-") + "--"
		return newest(filepath.Join(home, ".pi", "agent", "sessions", folder), false, func(name string) bool {
			return strings.HasSuffix(name, ".jsonl")
		})
	case "gemini":
		sum := sha256.Sum256([]byte(workDir))
		return newest(filepath.Join(home, ".gemini", "tmp", hex.EncodeToString(sum[:])), true, func(name string) bool {
			return strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".jsonl")
		})
	}
	return ""
}

// Read parses the transcript at path for provider into r. Oversized files are skipped.
func Read(path, provider string, r *Report) {
	info, err := os.Stat(path)
	if err != nil || info.Size() > 200<<20 {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	var lines []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 64<<20)
	for scanner.Scan() {
		if line := strings.TrimSpace(scanner.Text()); line != "" {
			lines = append(lines, line)
		}
	}
	switch provider {
	case "claude-code":
		Claude(lines, r)
	case "codex":
		Codex(lines, r)
	default:
		if strings.HasSuffix(path, ".jsonl") {
			for _, line := range lines {
				var v any
				if json.Unmarshal([]byte(line), &v) == nil {
					Generic(v, r)
				}
			}
		} else {
			var v any
			if json.Unmarshal([]byte(strings.Join(lines, "\n")), &v) == nil {
				Generic(v, r)
			}
		}
	}
}

package metrics

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CodexLifecycle builds a Lifecycle from a Codex rollout and the rollouts of
// the subagents it spawned. Codex only runs hooks whose hash the user has
// trusted in ~/.codex/config.toml, so the daemon can't rely on hooks there;
// the rollout carries the same lifecycle with timestamps (tool call → output
// by call_id, task_complete durations, subagent threads linked by
// parent_thread_id). Returns nil when the rollout can't be read.
func CodexLifecycle(path, home string, since time.Time) *Lifecycle {
	lines := readLines(path)
	if lines == nil {
		return nil
	}
	l := newLifecycle()
	l.source = "transcript"
	l.ownsTools = true
	thread := l.codexThread(lines, "")

	// Subagent rollouts sit beside the parent's in ~/.codex/sessions/YYYY/MM/DD;
	// a session crossing midnight puts them in a later day's folder.
	root := filepath.Join(home, ".codex", "sessions")
	cutoff := since.Add(-5 * time.Second)
	filepath.Walk(root, func(p string, info os.FileInfo, err error) error { //nolint:errcheck
		if err != nil || info.IsDir() || p == path || info.ModTime().Before(cutoff) ||
			!strings.HasPrefix(info.Name(), "rollout-") || !strings.HasSuffix(info.Name(), ".jsonl") {
			return nil
		}
		meta, ok := codexMeta(p)
		if !ok || meta.ParentThreadID != thread || thread == "" {
			return nil
		}
		typ := meta.AgentRole
		if typ == "" {
			typ = "default"
		}
		st := l.subagent(typ)
		if st == nil {
			return nil
		}
		st.Runs++
		sub := readLines(p)
		before := l.ActiveMs
		l.codexThread(sub, typ)
		// A subagent's turns are its run time, not the parent's active time.
		st.TotalMs += l.ActiveMs - before
		l.ActiveMs = before
		r := New("codex")
		Codex(sub, r)
		st.InputTokens, st.OutputTokens = st.InputTokens+r.InputTokens, st.OutputTokens+r.OutputTokens
		st.CacheReadTokens, st.CacheWriteTokens = st.CacheReadTokens+r.CacheReadTokens, st.CacheWriteTokens+r.CacheWriteTokens
		if r.Model != "" {
			st.Model = r.Model
		}
		l.subagentTokens = append(l.subagentTokens, r)
		return nil
	})
	return l
}

type codexSessionMeta struct {
	ID             string `json:"id"`
	ParentThreadID string `json:"parent_thread_id"`
	AgentRole      string `json:"agent_role"`
	Source         struct {
		Subagent struct {
			ThreadSpawn struct {
				AgentRole string `json:"agent_role"`
			} `json:"thread_spawn"`
		} `json:"subagent"`
	} `json:"source"`
}

// codexMeta reads only the rollout's first line (session_meta).
func codexMeta(path string) (codexSessionMeta, bool) {
	var meta codexSessionMeta
	f, err := os.Open(path)
	if err != nil {
		return meta, false
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 16<<20)
	if !scanner.Scan() {
		return meta, false
	}
	var line struct {
		Type    string           `json:"type"`
		Payload codexSessionMeta `json:"payload"`
	}
	if json.Unmarshal(scanner.Bytes(), &line) != nil || line.Type != "session_meta" {
		return meta, false
	}
	meta = line.Payload
	if meta.AgentRole == "" {
		meta.AgentRole = meta.Source.Subagent.ThreadSpawn.AgentRole
	}
	return meta, true
}

// codexThread folds one rollout into l and returns its thread id. Tool calls
// made inside a subagent (subagent != "") also count toward that subagent.
func (l *Lifecycle) codexThread(lines []string, subagent string) string {
	thread := ""
	pending := map[string]pendingCall{}
	for _, line := range lines {
		var o struct {
			Timestamp string         `json:"timestamp"`
			Type      string         `json:"type"`
			Payload   map[string]any `json:"payload"`
		}
		if json.Unmarshal([]byte(line), &o) != nil {
			continue
		}
		at, _ := time.Parse(time.RFC3339Nano, o.Timestamp)
		if !at.IsZero() {
			if l.firstEvent.IsZero() || at.Before(l.firstEvent) {
				l.firstEvent = at
			}
			if at.After(l.lastEvent) {
				l.lastEvent = at
			}
		}
		kind, _ := o.Payload["type"].(string)
		switch {
		case o.Type == "session_meta":
			if id, _ := o.Payload["id"].(string); thread == "" {
				thread = id
			}
			if subagent == "" {
				src, _ := o.Payload["source"].(string)
				bump(l.Sources, src)
			}
		case o.Type == "turn_context":
			if model, _ := o.Payload["model"].(string); model != "" {
				l.Models[model] = true
			}
		case o.Type == "response_item" && codexToolItems[kind]:
			name, _ := o.Payload["name"].(string)
			if name == "" {
				name = kind
				if kind == "local_shell_call" {
					name = "shell"
				}
			}
			st := l.tool(name)
			if st == nil {
				break
			}
			st.Calls++
			if subagent != "" {
				st.Subagent++
				if sa := l.subagent(subagent); sa != nil {
					sa.ToolCalls++
				}
			}
			if id, _ := o.Payload["call_id"].(string); id != "" && !at.IsZero() {
				pending[id] = pendingCall{name, at}
			}
		case o.Type == "response_item" && strings.HasSuffix(kind, "_output"):
			id, _ := o.Payload["call_id"].(string)
			p, ok := pending[id]
			if !ok {
				break
			}
			delete(pending, id)
			if st := l.Tools[p.name]; st != nil && !at.IsZero() {
				ms := at.Sub(p.at).Milliseconds()
				st.TotalMs += ms
				st.MaxMs = max(st.MaxMs, ms)
			}
		case o.Type == "event_msg" && kind == "task_started":
			if subagent == "" {
				l.Prompts++
			}
		case o.Type == "event_msg" && kind == "task_complete":
			ms := num(o.Payload["duration_ms"])
			l.ActiveMs += ms
			if subagent == "" {
				l.MaxTurnMs = max(l.MaxTurnMs, ms)
			}
			bump(l.Events, "TurnComplete")
		case o.Type == "event_msg" && kind == "turn_aborted":
			reason, _ := o.Payload["reason"].(string)
			if reason == "" {
				reason = "aborted"
			}
			bump(l.StopFailures, reason)
		case o.Type == "compacted":
			bump(l.Compactions, "auto")
		}
	}
	for _, p := range pending {
		if st := l.Tools[p.name]; st != nil {
			st.Unfinished++
		}
	}
	return thread
}

func readLines(path string) []string {
	info, err := os.Stat(path)
	if err != nil || info.Size() > 200<<20 {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	lines := []string{}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 64<<20)
	for scanner.Scan() {
		if line := strings.TrimSpace(scanner.Text()); line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

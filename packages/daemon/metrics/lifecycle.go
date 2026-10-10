package metrics

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Lifecycle aggregates a harness session from its own lifecycle hooks
// (Claude Code: SessionStart … SessionEnd, POSTed to /hooks/event). Hooks
// give what a transcript can't: wall-clock tool latency, permission
// denials, subagent runs, compactions, prompt-to-stop turn time and why the
// session ended. Like Report, it keeps names and counts only — never prompt,
// tool input or tool output content.
type Lifecycle struct {
	mu sync.Mutex

	firstEvent, lastEvent time.Time
	transcriptPath        string

	Events        map[string]int
	Sources       map[string]int // SessionStart source: startup|resume|clear|compact
	Tools         map[string]*ToolStat
	Subagents     map[string]*SubagentStat // keyed by agent_type
	Compactions   map[string]int           // manual|auto
	Notifications map[string]int           // notification_type
	StopFailures  map[string]int           // StopFailure error
	Models        map[string]bool
	Prompts       int
	ActiveMs      int64 // sum of prompt→Stop turn times
	MaxTurnMs     int64
	EndReason     string

	pendingTools  map[string]pendingCall // tool_use_id →
	pendingAgents map[string]pendingCall // agent_id →
	subagentRuns  map[string]string      // agent_id → agent_type, for token attribution
	subagentPaths map[string]string      // agent_id → its transcript (SubagentStop agent_transcript_path)
	turnStart     time.Time
}

// ToolStat is one tool's hook-observed usage. Ms is PreToolUse→PostToolUse
// wall time, so it includes time spent waiting on the user (AskUserQuestion).
type ToolStat struct {
	Calls    int   `json:"calls"`
	Errors   int   `json:"errors"`
	Denied   int   `json:"denied"`
	TotalMs  int64 `json:"total_ms"`
	MaxMs    int64 `json:"max_ms"`
	Subagent int   `json:"subagent_calls"` // calls made from inside a subagent
	// Unfinished calls never got a PostToolUse(Failure): blocked by a
	// permission rule without a PermissionDenied event, or interrupted.
	Unfinished int `json:"unfinished"`
}

// SubagentStat is one subagent type's usage across its runs.
type SubagentStat struct {
	Runs             int    `json:"runs"`
	TotalMs          int64  `json:"total_ms"`
	ToolCalls        int    `json:"tool_calls"`
	Model            string `json:"model,omitempty"`
	InputTokens      int64  `json:"input_tokens"`
	OutputTokens     int64  `json:"output_tokens"`
	CacheReadTokens  int64  `json:"cache_read_tokens"`
	CacheWriteTokens int64  `json:"cache_write_tokens"`
}

type pendingCall struct {
	name string
	at   time.Time
}

// maxKeys bounds every name→count map so a runaway session (thousands of
// distinct MCP tools, say) can't produce an oversized report.
const maxKeys = 200

func newLifecycle() *Lifecycle {
	return &Lifecycle{
		Events: map[string]int{}, Sources: map[string]int{}, Tools: map[string]*ToolStat{},
		Subagents: map[string]*SubagentStat{}, Compactions: map[string]int{}, Notifications: map[string]int{},
		StopFailures: map[string]int{}, Models: map[string]bool{},
		pendingTools: map[string]pendingCall{}, pendingAgents: map[string]pendingCall{}, subagentRuns: map[string]string{}, subagentPaths: map[string]string{},
	}
}

func bump(m map[string]int, key string) {
	if key == "" {
		return
	}
	if _, ok := m[key]; ok || len(m) < maxKeys {
		m[key]++
	}
}

var (
	registryMu sync.Mutex
	registry   = map[string]*Lifecycle{}
)

func key(agentID, taskID string) string { return agentID + "/" + taskID }

// Live returns the lifecycle being collected for agentID's taskID, creating it.
func Live(agentID, taskID string) *Lifecycle {
	registryMu.Lock()
	defer registryMu.Unlock()
	k := key(agentID, taskID)
	l := registry[k]
	if l == nil {
		l = newLifecycle()
		registry[k] = l
	}
	return l
}

// Take removes and returns the lifecycle for agentID's taskID (nil if no hook
// ever fired). It also drops any other entry for agentID: those belong to
// tasks the agent has already left, and would otherwise never be collected.
func Take(agentID, taskID string) *Lifecycle {
	registryMu.Lock()
	defer registryMu.Unlock()
	l := registry[key(agentID, taskID)]
	prefix := agentID + "/"
	for k := range registry {
		if strings.HasPrefix(k, prefix) {
			delete(registry, k)
		}
	}
	return l
}

// hookInput is the subset of Claude Code's hook payload the collector reads.
// Content-bearing fields (prompt, tool_input, tool_response,
// last_assistant_message …) are deliberately not decoded.
type hookInput struct {
	Event            string `json:"hook_event_name"`
	TranscriptPath   string `json:"transcript_path"`
	AgentID          string `json:"agent_id"`
	AgentType        string `json:"agent_type"`
	Source           string `json:"source"`
	Model            string `json:"model"`
	ToolName         string `json:"tool_name"`
	ToolUseID        string `json:"tool_use_id"`
	NotificationType string `json:"notification_type"`
	Error            string `json:"error"`
	Reason           string `json:"reason"`
	CompactReason    string `json:"compact_reason"`
	Trigger          string `json:"trigger"` // older PreCompact payloads
	ToModel          string `json:"to_model"`
	DurationMs       *int64 `json:"duration_ms"`           // PostToolUse: the harness's own tool timing
	AgentTranscript  string `json:"agent_transcript_path"` // SubagentStop
	ToolInput        struct {
		Skill string `json:"skill"`
	} `json:"tool_input"`
}

// ClaudeHook ingests one Claude Code hook payload received at now.
func (l *Lifecycle) ClaudeHook(body []byte, now time.Time) {
	var in hookInput
	if json.Unmarshal(body, &in) != nil || in.Event == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.firstEvent.IsZero() {
		l.firstEvent = now
	}
	l.lastEvent = now
	bump(l.Events, in.Event)
	// Subagent hooks carry the subagent's own transcript path; keep the main one.
	if in.TranscriptPath != "" && in.AgentID == "" {
		l.transcriptPath = in.TranscriptPath
	}

	switch in.Event {
	case "SessionStart":
		bump(l.Sources, in.Source)
		if in.Model != "" {
			l.Models[in.Model] = true
		}
	case "UserPromptSubmit":
		l.Prompts++
		l.turnStart = now
	case "Stop":
		if !l.turnStart.IsZero() {
			ms := now.Sub(l.turnStart).Milliseconds()
			l.ActiveMs += ms
			l.MaxTurnMs = max(l.MaxTurnMs, ms)
			l.turnStart = time.Time{}
		}
	case "StopFailure":
		bump(l.StopFailures, in.Error)
		l.turnStart = time.Time{}
	case "PreToolUse":
		st := l.tool(in.ToolName)
		if st == nil {
			break
		}
		st.Calls++
		if in.AgentID != "" {
			st.Subagent++
			if run := l.subagentRuns[in.AgentID]; run != "" {
				l.subagent(run).ToolCalls++
			}
		}
		if in.ToolUseID != "" {
			l.pendingTools[in.ToolUseID] = pendingCall{in.ToolName, now}
		}
	case "PostToolUse", "PostToolUseFailure":
		p, ok := l.pendingTools[in.ToolUseID]
		if ok {
			delete(l.pendingTools, in.ToolUseID)
		} else {
			p = pendingCall{name: in.ToolName}
		}
		st := l.tool(p.name)
		if st == nil {
			break
		}
		ms := int64(-1)
		if in.DurationMs != nil {
			ms = *in.DurationMs
		} else if !p.at.IsZero() {
			ms = now.Sub(p.at).Milliseconds()
		}
		if ms >= 0 {
			st.TotalMs += ms
			st.MaxMs = max(st.MaxMs, ms)
		}
		if in.Event == "PostToolUseFailure" {
			st.Errors++
		}
	case "PermissionDenied":
		delete(l.pendingTools, in.ToolUseID)
		if st := l.tool(in.ToolName); st != nil {
			st.Denied++
		}
	case "SubagentStart":
		typ := in.AgentType
		if typ == "" {
			typ = "unknown"
		}
		if in.AgentID != "" {
			l.pendingAgents[in.AgentID] = pendingCall{typ, now}
			l.subagentRuns[in.AgentID] = typ
		}
		if st := l.subagent(typ); st != nil {
			st.Runs++
		}
	case "SubagentStop":
		if in.AgentTranscript != "" && in.AgentID != "" {
			l.subagentPaths[in.AgentID] = in.AgentTranscript
		}
		p, ok := l.pendingAgents[in.AgentID]
		if !ok {
			break
		}
		delete(l.pendingAgents, in.AgentID)
		if st := l.subagent(p.name); st != nil {
			st.TotalMs += now.Sub(p.at).Milliseconds()
		}
	case "PreCompact":
		reason := in.CompactReason
		if reason == "" {
			reason = in.Trigger
		}
		bump(l.Compactions, reason)
	case "Notification":
		bump(l.Notifications, in.NotificationType)
	case "PostModelSwitch":
		if in.ToModel != "" {
			l.Models[in.ToModel] = true
		}
	case "SessionEnd":
		l.EndReason = in.Reason
	}
}

func (l *Lifecycle) tool(name string) *ToolStat {
	if name == "" {
		return nil
	}
	st := l.Tools[name]
	if st == nil {
		if len(l.Tools) >= maxKeys {
			return nil
		}
		st = &ToolStat{}
		l.Tools[name] = st
	}
	return st
}

func (l *Lifecycle) subagent(typ string) *SubagentStat {
	st := l.Subagents[typ]
	if st == nil {
		if len(l.Subagents) >= maxKeys {
			return nil
		}
		st = &SubagentStat{}
		l.Subagents[typ] = st
	}
	return st
}

// TranscriptPath is the main-session transcript the hooks reported, or "".
func (l *Lifecycle) TranscriptPath() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.transcriptPath
}

// Merge folds the lifecycle into r: hook tool counts replace transcript ones
// (they include subagent calls, which the main transcript never records),
// and each subagent's own transcript adds its tokens to r's totals.
func (l *Lifecycle) Merge(r *Report) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.Events["PreToolUse"] > 0 {
		r.Tools, r.ToolErrors = map[string]int{}, 0
		for name, st := range l.Tools {
			r.Tools[name] = st.Calls
			r.ToolErrors += st.Errors
		}
	}
	for id, p := range l.pendingTools {
		if st := l.Tools[p.name]; st != nil {
			st.Unfinished++
		}
		delete(l.pendingTools, id)
	}
	if l.Prompts > r.Turns {
		r.Turns = l.Prompts
	}
	if r.Model == "" {
		for m := range l.Models {
			r.Model = m
		}
	}

	// Subagent turns live in their own transcripts, never the main one.
	dir := filepath.Join(strings.TrimSuffix(l.transcriptPath, ".jsonl"), "subagents")
	for id, typ := range l.subagentRuns {
		path := l.subagentPaths[id]
		if path == "" && l.transcriptPath != "" {
			path = filepath.Join(dir, "agent-"+id+".jsonl")
		}
		if path != "" {
			sub := New(r.Provider)
			Read(path, r.Provider, sub)
			if st := l.Subagents[typ]; st != nil {
				st.InputTokens += sub.InputTokens
				st.OutputTokens += sub.OutputTokens
				st.CacheReadTokens += sub.CacheReadTokens
				st.CacheWriteTokens += sub.CacheWriteTokens
				if sub.Model != "" {
					st.Model = sub.Model
				}
			}
			r.InputTokens += sub.InputTokens
			r.OutputTokens += sub.OutputTokens
			r.CacheReadTokens += sub.CacheReadTokens
			r.CacheWriteTokens += sub.CacheWriteTokens
		}
	}

	models := make([]string, 0, len(l.Models))
	for m := range l.Models {
		models = append(models, m)
	}
	var span int64
	if !l.firstEvent.IsZero() {
		span = l.lastEvent.Sub(l.firstEvent).Milliseconds()
	}
	r.Lifecycle = map[string]any{
		"source": "hooks", "events": l.Events, "session_sources": l.Sources,
		"tools": l.Tools, "subagents": l.Subagents, "compactions": l.Compactions,
		"notifications": l.Notifications, "stop_failures": l.StopFailures, "models": models,
		"prompts": l.Prompts, "active_ms": l.ActiveMs, "max_turn_ms": l.MaxTurnMs,
		"hook_span_ms": span, "end_reason": l.EndReason,
	}
}

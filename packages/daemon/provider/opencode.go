package provider

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// OpenCode is the provider for sst/opencode CLI.
//
// OpenCode uses TypeScript plugins (`.ts` files in `.opencode/plugins/`).
// Setup() writes a plugin that accumulates assistant message text parts via
// message.part.updated events, marks them complete via message.updated, then
// on session.idle combines all parts and POSTs to /hooks/stop with the full text.
// Separately, openCodeAnalyticsJS translates bus events into lifecycle hooks
// for session analytics (POST /hooks/event).
type OpenCode struct{}

// openCodeAnalyticsJS turns OpenCode bus events into the Claude-shaped hook
// payloads metrics.Lifecycle reads: tool parts → PreToolUse/PostToolUse with
// the part's own start/end time, completed assistant messages → Usage
// (tokens, cost, model — OpenCode keeps no transcript the daemon can parse),
// child sessions → SubagentStart/Stop. Posts go through one promise chain so
// they arrive in order without blocking the event handler. Names and counts
// only: no prompt, tool input or output is sent.
const openCodeAnalyticsJS = `const lifecycleURL = "/hooks/event?agent=%s&task_id=%s&provider=opencode"
  let lifecycleQueue = Promise.resolve()
  const emit = (name, body) => {
    lifecycleQueue = lifecycleQueue.then(() => post(lifecycleURL, { hook_event_name: name, ...body }))
  }
  let mainSession = null
  const children = new Map() // child sessionID → agent type
  const toolState = new Map() // callID → "started" | "done"
  const seenMessages = new Set()
  const analytics = (event) => {
    const p = event.properties || {}
    const agentOf = (sid) => (sid && children.has(sid) ? sid : undefined)
    if (event.type === "session.created" && p.info) {
      if (p.info.parentID) {
        const m = /\(@([\w.-]+) subagent\)/.exec(p.info.title || "")
        const type = m ? m[1] : "subagent"
        children.set(p.info.id, type)
        emit("SubagentStart", { agent_id: p.info.id, agent_type: type })
      } else if (!mainSession) {
        mainSession = p.info.id
        emit("SessionStart", { source: "startup" })
      }
    }
    if (event.type === "message.updated" && p.info && !seenMessages.has(p.info.id)) {
      const info = p.info
      if (info.role === "user" && !mainSession && !children.has(info.sessionID)) mainSession = info.sessionID
      if (info.role === "user" && info.sessionID === mainSession) {
        seenMessages.add(info.id)
        emit("UserPromptSubmit", { session_id: info.sessionID, message_id: info.id })
      }
      if (info.role === "assistant" && info.time?.completed) {
        seenMessages.add(info.id)
        const t = info.tokens || {}
        emit("Usage", {
          message_id: info.id, agent_id: agentOf(info.sessionID),
          model: info.modelID ? (info.providerID ? info.providerID + "/" : "") + info.modelID : "",
          input_tokens: t.input || 0, output_tokens: (t.output || 0) + (t.reasoning || 0),
          cache_read_tokens: t.cache?.read || 0, cache_write_tokens: t.cache?.write || 0,
          cost: typeof info.cost === "number" ? info.cost : undefined,
        })
        if (info.error && !children.has(info.sessionID)) emit("StopFailure", { error: info.error.name || "error" })
      }
    }
    if (event.type === "message.part.updated" && p.part?.type === "tool" && p.part.callID) {
      const part = p.part, status = part.state?.status, seen = toolState.get(part.callID)
      if (!seen && status) {
        toolState.set(part.callID, "started")
        emit("PreToolUse", { tool_name: part.tool, tool_use_id: part.callID, agent_id: agentOf(part.sessionID) })
      }
      if (seen !== "done" && (status === "completed" || status === "error")) {
        toolState.set(part.callID, "done")
        const tm = part.state.time || {}
        emit(status === "error" ? "PostToolUseFailure" : "PostToolUse", {
          tool_name: part.tool, tool_use_id: part.callID, agent_id: agentOf(part.sessionID),
          duration_ms: tm.start && tm.end ? tm.end - tm.start : undefined,
        })
      }
    }
    if (event.type === "session.status" && p.status?.type === "idle") {
      if (children.has(p.sessionID)) emit("SubagentStop", { agent_id: p.sessionID, agent_type: children.get(p.sessionID) })
      else if (p.sessionID === mainSession) emit("Stop", {})
    }
    if (event.type === "session.compacted" && !children.has(p.sessionID)) emit("PreCompact", { compact_reason: "auto" })
    if (event.type === "session.error" && !children.has(p.sessionID)) emit("StopFailure", { error: p.error?.name || "error" })
  }`

func (p *OpenCode) Name() string    { return "opencode" }
func (p *OpenCode) CLIName() string { return "opencode" }

// Setup writes .opencode/plugins/tasksquad.ts in workDir.
// The plugin exports event handlers for lifecycle events following the Go SDK
// patterns (session.*, message.*, tool.*).
// It POSTs to the daemon's local hook server so the agent knows when to stop
// or when a response (reply) is available.
func (p *OpenCode) Setup(workDir string, hooksPort int, agentID string, taskID string) error {
	pluginDir := filepath.Join(workDir, ".opencode", "plugins")
	if err := os.MkdirAll(pluginDir, 0755); err != nil {
		return err
	}
	// Remove the old .mjs plugin if present (migrated back to .ts).
	os.Remove(filepath.Join(pluginDir, "tasksquad.mjs")) //nolint:errcheck
	plugin := fmt.Sprintf(`// Auto-generated by tsq daemon — do not edit

export const TaskSquadPlugin = async ({ client }) => {
  await client.app.log({ body: { service: "tasksquad", level: "info", message: "Plugin initialized" } })

  const post = async (path, body) => {
    try {
      await fetch("http://localhost:%d" + path, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (process.env.TSQ_HOOK_TOKEN ?? "") },
        body: JSON.stringify(body)
      })
    } catch (e) {
      await client.app.log({ body: { service: "tasksquad", level: "error", message: "hook error: " + e.message } })
    }
  }

  // @analytics

  const messageCache = new Map()
  let pendingToolCount = 0
  let sessionIdleSent = false

  return {
    "event": async (input) => {
      const { event } = input
      analytics(event)

      if (event.type === "message.part.updated" && event.properties?.part) {
        const part = event.properties.part
        if (part.type === "text" && part.messageID) {
          if (!messageCache.has(part.messageID)) {
            messageCache.set(part.messageID, { sessionID: part.sessionID, textParts: [], completed: false })
          }
          const cached = messageCache.get(part.messageID)
          const existing = cached.textParts.find(p => p.id === part.id)
          if (existing) {
            existing.text = part.text || ""
          } else {
            cached.textParts.push({ id: part.id, text: part.text || "" })
          }
        }
      }

      if (event.type === "message.updated" && event.properties?.info) {
        const info = event.properties.info
        if (info.role === "assistant" && info.time?.completed && messageCache.has(info.id)) {
          messageCache.get(info.id).completed = true
        }
      }

      if (event.type === "tool.execute.before") {
        pendingToolCount++
        await client.app.log({ body: { service: "tasksquad", level: "info", message: "tool.execute.before: " + pendingToolCount } })
      }

      if (event.type === "tool.execute.after") {
        pendingToolCount = Math.max(0, pendingToolCount - 1)
        await client.app.log({ body: { service: "tasksquad", level: "info", message: "tool.execute.after: pending=" + pendingToolCount } })
        // When tools complete and session goes idle, send stop hook
        if (pendingToolCount === 0 && !sessionIdleSent) {
          let lastCompleted = null
          for (const [, cached] of messageCache.entries()) {
            if (cached.completed) lastCompleted = cached
          }
          const message = lastCompleted ? lastCompleted.textParts.map(p => p.text).join("") : ""
          await post("/hooks/stop?agent=%s&task_id=%s&provider=opencode", { stop_reason: "idle", message })
          sessionIdleSent = true
        }
      }

      if (event.type === "session.idle") {
        await client.app.log({ body: { service: "tasksquad", level: "info", message: "session.idle pending=" + pendingToolCount } })
        if (pendingToolCount === 0 && !sessionIdleSent) {
          let lastCompleted = null
          for (const [, cached] of messageCache.entries()) {
            if (cached.completed) lastCompleted = cached
          }
          const message = lastCompleted ? lastCompleted.textParts.map(p => p.text).join("") : ""
          await post("/hooks/stop?agent=%s&task_id=%s&provider=opencode", { stop_reason: "idle", message })
          sessionIdleSent = true
        }
      }

      if (event.type === "session.error") {
        await client.app.log({ body: { service: "tasksquad", level: "error", message: "session.error" } })
        await post("/hooks/stop?agent=%s&task_id=%s&provider=opencode", { stop_reason: "error", message: event.properties?.error?.message || "Unknown error" })
      }

      // Reset on new user message to handle multiple turns
      if (event.type === "session.updated" && event.properties?.info?.role === "user") {
        sessionIdleSent = false
        messageCache.clear()
        pendingToolCount = 0
      }
    },
  }
}
`, hooksPort, agentID, taskID, agentID, taskID, agentID, taskID)
	plugin = strings.Replace(plugin, "// @analytics", fmt.Sprintf(openCodeAnalyticsJS, agentID, taskID), 1)
	return os.WriteFile(filepath.Join(pluginDir, "tasksquad.ts"), []byte(plugin), 0644)
}

func (p *OpenCode) UsesHooks() bool                       { return true }
func (p *OpenCode) Stdin(prompt string) string            { return prompt }
func (p *OpenCode) Env(_ int) []string                    { return nil }
func (p *OpenCode) SetupArgs(_ int, _, _ string) []string { return nil }
func (p *OpenCode) ExtraArgs() []string                   { return []string{"--print-logs"} }

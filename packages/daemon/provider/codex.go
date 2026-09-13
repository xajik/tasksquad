package provider

import (
	"encoding/json"
	"fmt"
	"net/url"
)

// Codex runs an interactive TUI in tmux. notify is an argv array and Codex
// appends the event JSON as its final argument (it does not write to stdin).
// All routing is scoped to this invocation; personal config is never changed.
type Codex struct{}

func (p *Codex) Name() string                             { return "codex" }
func (p *Codex) CLIName() string                          { return "codex" }
func (p *Codex) UsesHooks() bool                          { return true }
func (p *Codex) Env(_ int) []string                       { return nil }
func (p *Codex) Stdin(prompt string) string               { return prompt }
func (p *Codex) ExtraArgs() []string                      { return []string{"--no-alt-screen"} }
func (p *Codex) Setup(_ string, _ int, _, _ string) error { return nil }
func (p *Codex) SetupVoice(_ string, _ int) error         { return nil }
func (p *Codex) VoiceCLIArg() string                      { return "" }
func (p *Codex) VoiceInitCommand() string                 { return "$tsq-speech-to-md" }

func (p *Codex) SetupArgs(port int, agentID, taskID string) []string {
	q := url.Values{"agent": {agentID}, "task_id": {taskID}}
	return codexNotifyArgs(fmt.Sprintf("http://127.0.0.1:%d/hooks/codex?%s", port, q.Encode()))
}

func (p *Codex) VoiceSetupArgs(port int) []string {
	return codexNotifyArgs(fmt.Sprintf("http://127.0.0.1:%d/hooks/stop?speech=true&provider=codex", port))
}

func codexNotifyArgs(endpoint string) []string {
	// The endpoint is passed as an argument, never interpolated into shell code.
	// Bound the callback so a stopped daemon cannot hold up a Codex turn.
	argv := []string{"sh", "-c", `curl --silent --show-error --fail --max-time 5 -X POST "$1" -H 'Content-Type: application/json' --data-binary "$2" >/dev/null`, "tsq-codex-notify", endpoint}
	encoded, _ := json.Marshal(argv)
	return []string{"-c", "notify=" + string(encoded)}
}

// FormatPrompt translates TaskSquad's slash skill invocations for Codex.
// Ordinary prompts and Codex built-in slash commands are preserved.
func (p *Codex) FormatPrompt(prompt string) string {
	return codexSkillPrompt(prompt)
}

// InitialPromptArgs queues the first prompt inside Codex. Typing it into tmux
// at startup could accidentally answer a trust or onboarding dialog instead.
func (p *Codex) InitialPromptArgs(prompt string) []string { return []string{"--", prompt} }

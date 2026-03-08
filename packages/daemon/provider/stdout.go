package provider

// Stdout is a fallback provider for any CLI tool that does not support HTTP hooks.
//
// Completion is detected via process exit code only:
//   - exit 0  → status "closed"
//   - exit != 0 → status "crashed"
//
// TODO: Add optional completion_pattern (regex) in AgentConfig so stdout lines
// can be scanned for a completion marker (e.g. "✓ Done", "Task complete").
// When matched, the agent can call complete() without waiting for process exit.

type Stdout struct{}

func (p *Stdout) Name() string                { return "stdout" }
func (p *Stdout) UsesHooks() bool             { return false }
func (p *Stdout) Env(_ int) []string          { return nil }
func (p *Stdout) Stdin(_ string) string       { return "" }
func (p *Stdout) ExtraArgs() []string         { return nil }
func (p *Stdout) Setup(_ string, _ int) error { return nil }

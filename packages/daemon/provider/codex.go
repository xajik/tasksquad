package provider

import "fmt"

// Codex is the provider for OpenAI's codex CLI.
//
// TODO: Implement Codex hook support.
//
// The OpenAI Codex CLI supports hooks via the CODEX_HOOKS_SERVER_URL environment
// variable. When set, codex POSTs lifecycle events to that URL.
//
// Expected env var (verify against codex docs):
//
//	CODEX_HOOKS_SERVER_URL=http://localhost:{port}/hooks/codex
//
// Once implemented:
//   - Env() returns ["CODEX_HOOKS_SERVER_URL=http://localhost:{port}/hooks/codex"]
//   - UsesHooks() returns true
//   - hooks/server.go needs a POST /hooks/codex handler that maps codex event
//     shapes to agent.Complete() / agent.SetWaitingInput()

type Codex struct{}

func (p *Codex) Name() string { return "codex" }

// TODO: return true once CODEX_HOOKS_SERVER_URL support is verified.
func (p *Codex) UsesHooks() bool { return false }

// TODO: return ["CODEX_HOOKS_SERVER_URL=http://localhost:{port}/hooks/codex"]
func (p *Codex) Env(_ int) []string { return nil }

// Env with port — placeholder so it's easy to wire up.
// nolint:unused
func (p *Codex) envWithPort(hooksPort int) []string {
	return []string{fmt.Sprintf("CODEX_HOOKS_SERVER_URL=http://localhost:%d/hooks/codex", hooksPort)}
}

func (p *Codex) Setup(_ string, _ int) error { return nil }

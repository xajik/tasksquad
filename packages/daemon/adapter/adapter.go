// Package adapter provides per-agent runtime adapters for parsing hook payloads
// and extracting responses from provider-specific transcript files.
//
// This is the runtime counterpart to the provider package (which handles
// setup-time concerns like writing config files and setting environment variables).
// Each agent type has its own small file; adding a new agent only requires
// creating that file and registering it in For().
package adapter

// StopEvent is the normalized result of parsing a /hooks/stop payload.
type StopEvent struct {
	Reason         string // provider-native reason, e.g. "end_turn", "max_turns", "error"
	TranscriptPath string
	HookMessage    string // pre-extracted final text (OpenCode "message" field); empty for others
	IsFailure      bool
}

// NotificationEvent is the normalized result of parsing a /hooks/notification payload.
type NotificationEvent struct {
	Message        string
	TranscriptPath string
}

// AfterAgentEvent is the normalized result of parsing a /hooks/after_agent payload.
// Only Gemini produces this event; other adapters return the zero value.
type AfterAgentEvent struct {
	PromptResponse string
	TranscriptPath string
}

// Adapter handles agent-specific hook payload parsing and transcript extraction
// at runtime. Implementations live in this package, one file per agent type.
type Adapter interface {
	// ParseStop parses a raw /hooks/stop body.
	// isFailure is derived from the ?failure=true query parameter.
	ParseStop(body []byte, isFailure bool) (StopEvent, error)

	// ParseNotification parses a raw /hooks/notification body.
	ParseNotification(body []byte) (NotificationEvent, error)

	// ParseAfterAgent parses a raw /hooks/after_agent body.
	// Non-Gemini adapters return a zero-value AfterAgentEvent and nil error.
	ParseAfterAgent(body []byte) (AfterAgentEvent, error)

	// ExtractTranscript reads the provider-specific transcript file at path and
	// returns the text of the last assistant message. Returns "" on any error
	// so callers can fall back to terminal output.
	ExtractTranscript(path string) string
}

// adapterRegistry maps provider names to their Adapter implementations.
// Unknown names (including "") fall back to ClaudeAdapter via For().
var adapterRegistry = map[string]Adapter{
	"gemini":   GeminiAdapter{},
	"codex":    CodexAdapter{},
	"opencode": OpenCodeAdapter{},
	"pi":       PiAdapter{},
	"stdout":   StdoutAdapter{},
	"claw":     ClawAdapter{},
}

// For returns the Adapter for the given provider name.
// The name matches the values returned by provider.Provider.Name():
// "claude-code", "gemini", "codex", "opencode", "stdout".
// Unknown names (including "") fall back to ClaudeAdapter, which matches the
// existing default behaviour for StopFailure hooks that omit ?provider=.
func For(providerName string) Adapter {
	if a, ok := adapterRegistry[providerName]; ok {
		return a
	}
	return ClaudeAdapter{} // "claude-code", "claude", or any unknown name
}

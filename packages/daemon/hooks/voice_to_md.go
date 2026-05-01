package hooks

// SpeechToMDHandler receives speech-to-md turn-complete events from the agent.
// All provider turn signals are routed through /hooks/stop?speech=true.
type SpeechToMDHandler interface {
	// HandleNotification is called when the provider signals a turn is complete.
	// message is the assistant text extracted from the transcript; may be empty
	// during init (the Stop event itself is the ready signal).
	HandleNotification(message string)
}

package adapter

// StdoutAdapter is a no-op adapter for the stdout provider.
// Stdout agents rely on process-exit detection and produce no hooks or transcripts.
type StdoutAdapter struct{}

func (StdoutAdapter) ParseStop(_ []byte, _ bool) (StopEvent, error)         { return StopEvent{}, nil }
func (StdoutAdapter) ParseNotification(_ []byte) (NotificationEvent, error)  { return NotificationEvent{}, nil }
func (StdoutAdapter) ParseAfterAgent(_ []byte) (AfterAgentEvent, error)      { return AfterAgentEvent{}, nil }
func (StdoutAdapter) ExtractTranscript(_ string) string                       { return "" }

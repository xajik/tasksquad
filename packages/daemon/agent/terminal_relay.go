package agent

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/gorilla/websocket"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

// relayWriter is an io.Writer that forwards raw PTY bytes to the terminal relay WebSocket.
// It is used with io.TeeReader so the raw stream is relayed before any ANSI stripping.
type relayWriter struct {
	conn *websocket.Conn
}

func (r *relayWriter) Write(p []byte) (int, error) {
	if r.conn == nil {
		return len(p), nil
	}
	chunk := make([]byte, len(p))
	copy(chunk, p)
	if err := r.conn.WriteMessage(websocket.BinaryMessage, chunk); err != nil {
		// Non-fatal: relay errors don't affect local output capture
		logger.Warn(fmt.Sprintf("terminal relay write error: %v", err))
	}
	return len(p), nil
}

// dialTerminalRelay connects to the TerminalRelay Durable Object for the given session.
// Returns nil on failure so callers can proceed without the relay.
func dialTerminalRelay(cfg *config.Config, token, agentID, sessionID string) *websocket.Conn {
	serverURL := cfg.Server.URL
	wsURL := strings.NewReplacer("https://", "wss://", "http://", "ws://").Replace(serverURL) + "/terminal/" + sessionID
	header := http.Header{
		"Authorization": {"Bearer " + token},
		"X-TSQ-Agent":   {agentID},
	}
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		logger.Warn(fmt.Sprintf("[terminal relay] dial failed (session=%s): %v", sessionID, err))
		return nil
	}
	logger.Info(fmt.Sprintf("[terminal relay] connected for session %s", sessionID))
	return conn
}

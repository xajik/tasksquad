package agent

import (
	"bufio"
	"fmt"
	"io"
	"time"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

// writeRunLog writes a timestamped line to the current per-task log file (if open).
func (a *Agent) writeRunLog(msg string) {
	a.st.mu.Lock()
	f := a.st.runLog
	a.st.mu.Unlock()
	if f == nil {
		return
	}
	fmt.Fprintf(f, "%s %s\n", time.Now().Format(time.RFC3339), msg)
}

// streamOutput drains a process output reader (FIFO or stdout pipe).
// Raw PTY bytes are forwarded to the terminal relay WebSocket (if connected) before
// any processing, providing 1-to-1 rendering in the browser via xterm.js.
// Cleaned lines (ANSI stripped) are appended to outputLines and written to the run log.
func (a *Agent) streamOutput(cfg *config.Config, agentID string, r io.Reader) {
	a.st.mu.Lock()
	runLog := a.st.runLog
	a.st.mu.Unlock()

	// Tee raw bytes to the relay before the scanner strips ANSI sequences.
	src := io.Reader(r)
	if a.relayConn != nil {
		src = io.TeeReader(r, &relayWriter{conn: a.relayConn})
	}

	scanner := bufio.NewScanner(src)
	// OpenCode renders full-screen TUI frames that can be very large ANSI blobs.
	// The default 64KB limit causes scanner to fail silently, closing outputDone
	// and triggering a false crash. Use a 4MB buffer to handle any real-world frame.
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	for scanner.Scan() {
		line := cleanLine(scanner.Text())
		if line == "" {
			continue // skip pure escape-sequence lines (TUI redraws, clear-screen, etc.)
		}

		// Append to outputLines immediately so SetWaitingInput can read the
		// latest content when the Notification hook fires.
		a.st.mu.Lock()
		a.st.outputLines = append(a.st.outputLines, line)
		a.st.mu.Unlock()

		// Write to the per-task run log immediately.
		if runLog != nil {
			fmt.Fprintln(runLog, line)
		}
	}
	if err := scanner.Err(); err != nil {
		logger.Warn(fmt.Sprintf("[%s] streamOutput scanner error: %v", a.Config.Name, err))
	}
}

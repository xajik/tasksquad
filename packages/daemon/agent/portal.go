package agent

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
	"github.com/tasksquad/daemon/tmux"
)

// portalRecord holds the fields from the batch heartbeat portal assignment.
type portalRecord struct {
	id string
}

// handlePortal starts a tmux session for the portal, streams output via the DO
// relay, and reports open/close to the server. Run in a goroutine.
func (a *Agent) handlePortal(cfg *config.Config, p *portalRecord) {
	if !atomic.CompareAndSwapInt32(&a.portalActive, 0, 1) {
		logger.Warn(fmt.Sprintf("[%s] portal %s skipped — portal already active", a.Config.Name, p.id))
		return
	}
	defer atomic.StoreInt32(&a.portalActive, 0)

	// Drain any stale close signal left over from a previous portal invocation.
	select {
	case <-a.portalSignals:
	default:
	}

	logger.Info(fmt.Sprintf("[%s] portal %s: starting", a.Config.Name, p.id))

	if tmuxBin == "" {
		logger.Error("[portal] tmux required but not found")
		a.reportPortalClose(cfg, p.id, "failed")
		return
	}

	// Session key = portal ID (first 8 chars for tmux name readability).
	sessionID := p.id
	sessionSuffix := sessionID
	if len(sessionSuffix) > 8 {
		sessionSuffix = sessionSuffix[:8]
	}
	sessionName := fmt.Sprintf("tsq-portal-%s", sessionSuffix)
	fifoPath := fmt.Sprintf("/tmp/tsq-portal-%s.fifo", sessionSuffix)
	os.Remove(fifoPath)

	if err := mkfifo(fifoPath, 0644); err != nil {
		logger.Error(fmt.Sprintf("[portal] mkfifo failed: %v", err))
		a.reportPortalClose(cfg, p.id, "failed")
		return
	}
	defer os.Remove(fifoPath)

	// Launch harness command interactively in tmux (no -p flag = interactive REPL).
	parts := strings.Fields(a.Config.Command)
	newSessionArgs := append([]string{"new-session", "-d", "-s", sessionName, "-c", a.Config.WorkDir, "--"}, parts...)
	tmuxCmd := exec.Command(tmuxBin, newSessionArgs...)
	tmuxCmd.Env = os.Environ()
	if err := tmuxCmd.Run(); err != nil {
		logger.Error(fmt.Sprintf("[portal] tmux new-session failed: %v", err))
		a.reportPortalClose(cfg, p.id, "failed")
		return
	}
	defer exec.Command(tmuxBin, "kill-session", "-t", sessionName).Run() //nolint:errcheck

	exec.Command(tmuxBin, "pipe-pane", "-t", sessionName, "cat > "+fifoPath).Run() //nolint:errcheck
	tmux.WaitForReady()

	// Open the FIFO using non-blocking polling so the goroutine can be cancelled
	// if the 5-second timeout fires — preventing a file-descriptor leak.
	done := make(chan struct{})
	fifoCh := make(chan *os.File, 1)
	go func() {
		for {
			f, err := os.OpenFile(fifoPath, os.O_RDONLY|syscall.O_NONBLOCK, 0)
			if err == nil {
				select {
				case fifoCh <- f:
				case <-done:
					f.Close()
				}
				return
			}
			select {
			case <-done:
				return
			case <-time.After(50 * time.Millisecond):
			}
		}
	}()

	var fifoFile *os.File
	select {
	case f := <-fifoCh:
		fifoFile = f
		defer close(done)
	case <-time.After(5 * time.Second):
		close(done) // goroutine will clean up any opened fd
		logger.Error(fmt.Sprintf("[portal] FIFO timed out for portal %s", p.id))
		a.reportPortalClose(cfg, p.id, "failed")
		return
	}
	defer fifoFile.Close()

	// Tell the server the portal is now running — this sets portals.session_id,
	// which the relay auth check requires before the daemon can dial the relay.
	closeNow, err := a.reportPortalOpen(cfg, p.id, sessionID)
	if err != nil {
		logger.Error(fmt.Sprintf("[portal] reportPortalOpen failed: %v", err))
		a.reportPortalClose(cfg, p.id, "failed")
		return
	}
	if closeNow {
		// Server indicated the portal was already closed by the browser.
		logger.Info(fmt.Sprintf("[%s] portal %s: close_now received — browser already closed", a.Config.Name, p.id))
		a.reportPortalClose(cfg, p.id, "done")
		return
	}

	// Connect to the TerminalRelay DO (portals.session_id is now set, auth passes).
	token, _ := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	var relay *websocket.Conn
	if token != "" {
		relay = dialTerminalRelay(cfg, token, a.Config.ID, sessionID)
		if relay != nil {
			defer relay.Close()
			// Start relay reader: forwards browser stdin and resize frames to tmux.
			go handleRelayInput(relay, sessionName)
		}
	}

	// Close watcher: kills the tmux session when the browser requests close or
	// when the server detects a crash (close signal arrives via portalSignals).
	doneCh := make(chan struct{})
	go func() {
		select {
		case id := <-a.portalSignals:
			if id == p.id {
				logger.Info(fmt.Sprintf("[%s] portal %s: close signal received — killing tmux", a.Config.Name, p.id))
				exec.Command(tmuxBin, "kill-session", "-t", sessionName).Run() //nolint:errcheck
			}
		case <-doneCh:
		}
	}()

	// Stream raw PTY bytes to the relay until the FIFO closes (naturally or via kill).
	streamPortalOutput(fifoFile, relay)
	close(doneCh)

	a.reportPortalClose(cfg, p.id, "done")
	logger.Info(fmt.Sprintf("[%s] portal %s: done", a.Config.Name, p.id))
}

// handleRelayInput reads control frames from the browser via the relay WebSocket
// and dispatches them to the tmux session.
// Frame format (JSON text):
//
//	{ "t": "i", "d": "<base64 stdin bytes>" }   — stdin keystrokes
//	{ "t": "r", "c": <cols>, "r": <rows> }       — terminal resize
func handleRelayInput(relay *websocket.Conn, sessionName string) {
	for {
		_, msg, err := relay.ReadMessage()
		if err != nil {
			break
		}
		var frame map[string]any
		if json.Unmarshal(msg, &frame) != nil {
			continue
		}
		switch frame["t"] {
		case "i":
			encoded, _ := frame["d"].(string)
			data, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil || len(data) == 0 {
				continue
			}
			exec.Command(tmuxBin, "send-keys", "-t", sessionName, "-l", string(data)).Run() //nolint:errcheck
		case "r":
			cols := int(toFloat64(frame["c"]))
			rows := int(toFloat64(frame["r"]))
			if cols > 0 && rows > 0 {
				exec.Command(tmuxBin, "resize-window", "-t", sessionName,
					"-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows)).Run() //nolint:errcheck
			}
		}
	}
}

func toFloat64(v any) float64 {
	f, _ := v.(float64)
	return f
}

// streamPortalOutput reads raw PTY bytes from r and forwards them to the relay.
func streamPortalOutput(r io.Reader, relay *websocket.Conn) {
	buf := make([]byte, 4096)
	rw := &relayWriter{conn: relay}
	var total int
	for {
		n, err := r.Read(buf)
		if n > 0 {
			total += n
			rw.Write(buf[:n]) //nolint:errcheck
		}
		if err != nil {
			logger.Info(fmt.Sprintf("[portal] FIFO stream ended: %d bytes total, err=%v", total, err))
			break
		}
	}
}

func (a *Agent) reportPortalOpen(cfg *config.Config, portalID, sessionID string) (bool, error) {
	resp, err := a.post(cfg, "/daemon/portal/open", map[string]any{
		"portal_id":  portalID,
		"session_id": sessionID,
	})
	if err != nil {
		return false, err
	}
	closeNow, _ := resp["close_now"].(bool)
	return closeNow, nil
}

func (a *Agent) reportPortalClose(cfg *config.Config, portalID, status string) {
	a.post(cfg, "/daemon/portal/close", map[string]any{ //nolint:errcheck
		"portal_id": portalID,
		"status":    status,
	})
}

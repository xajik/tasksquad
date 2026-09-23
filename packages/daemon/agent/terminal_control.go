package agent

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/tasksquad/daemon/agentmode"
	"github.com/tasksquad/daemon/config"
)

var terminalPaneID = regexp.MustCompile(`^%[0-9]+$`)

// SendTerminalInput keeps native terminal submissions in the same lifecycle as
// inbox replies. Identity checks and the write share the state lock, so a stale
// viewer cannot type into a replacement task. No shell evaluates input bytes.
func (a *Agent) SendTerminalInput(ctx context.Context, taskID, session, pane string, data []byte, submit bool) error {
	if !terminalPaneID.MatchString(pane) || len(data) == 0 || len(data) > 4096 || (submit && !bytes.ContainsAny(data, "\r\n")) {
		return fmt.Errorf("invalid terminal input")
	}
	a.st.mu.Lock()
	defer a.st.mu.Unlock()
	if taskID == "" || session == "" || a.st.taskID != taskID || a.st.tmuxSession != session || a.st.completing || (a.st.mode != ModeRunning && a.st.mode != ModeWaitingInput) {
		return fmt.Errorf("terminal no longer belongs to an active task")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	owner, err := exec.CommandContext(ctx, tmuxBin, "display-message", "-p", "-t", pane, "#{session_name}").Output()
	if err != nil || strings.TrimSpace(string(owner)) != session {
		return fmt.Errorf("pane does not belong to this task session")
	}
	args := []string{"send-keys", "-H", "-t", pane}
	for _, b := range data {
		args = append(args, fmt.Sprintf("%02x", b))
	}
	// Completion hooks acquire this same lock: they cannot observe waiting_input
	// between delivery of Enter and the corresponding mode transition.
	if err := exec.CommandContext(ctx, tmuxBin, args...).Run(); err != nil {
		return fmt.Errorf("send terminal input: %w", err)
	}
	if submit && a.st.mode == ModeWaitingInput {
		a.st.mode = validTransitions[ModeWaitingInput][EventUserReplied]
		a.st.notifyPosted = false
		a.st.tuiBlocked = false
	}
	return nil
}

// CloseTerminalSession claims completion before terminating tmux. A pipe EOF
// therefore cannot race this intentional close and report it as a crash.
func (a *Agent) CloseTerminalSession(cfg *config.Config, taskID, session string) bool {
	if taskID == "" || session == "" {
		return false
	}
	return a.completeScoped(cfg, string(agentmode.StatusClosed), "", taskID, session)
}

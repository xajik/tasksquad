// Package screenshot renders a tmux pane's current contents (full ANSI
// color/attributes preserved) into a PNG image, for cases where a visual
// snapshot is more useful than ANSI-stripped text — e.g. the supervisor
// inspecting a stuck TUI session.
package screenshot

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

const tmuxBin = "tmux"

// Capture renders the given tmux pane to a PNG image, preserving ANSI
// color/attributes. scrollbackLines == 0 captures only the currently
// visible pane; a positive value also includes that many lines of
// scrollback history.
func Capture(session string, scrollbackLines int) ([]byte, error) {
	raw, err := capturePaneANSI(session, scrollbackLines)
	if err != nil {
		return nil, err
	}

	cols, err := paneWidth(session)
	if err != nil || cols <= 0 {
		// Rare race (session vanished between the two tmux calls) — fall
		// back to an approximate width so we still produce an image.
		cols = longestLine(raw)
	}
	if cols <= 0 {
		cols = 80
	}

	grid := parseGrid(raw, cols)
	return renderPNG(grid)
}

func capturePaneANSI(session string, scrollbackLines int) (string, error) {
	args := []string{"capture-pane", "-t", session, "-e", "-p"}
	if scrollbackLines > 0 {
		args = append(args, "-S", fmt.Sprintf("-%d", scrollbackLines))
	}
	out, err := exec.Command(tmuxBin, args...).Output()
	if err != nil {
		return "", fmt.Errorf("tmux capture-pane: %w", err)
	}
	return string(out), nil
}

func paneWidth(session string) (int, error) {
	out, err := exec.Command(tmuxBin, "display-message", "-t", session, "-p", "#{pane_width}").Output()
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(out)))
}

func longestLine(s string) int {
	max := 0
	for _, line := range strings.Split(s, "\n") {
		if n := len([]rune(line)); n > max {
			max = n
		}
	}
	return max
}

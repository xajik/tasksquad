package tmuxcmd

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"

	tmuxpkg "github.com/tasksquad/daemon/tmux"
	"github.com/tasksquad/daemon/util"
)

const sessionPrefix = "tsq-"

func sessionNameFromArg(arg string) string {
	return tmuxpkg.NormalizeSessionName(arg)
}

func RunSessions() {
	out, err := exec.Command("tmux", "list-sessions", "-F",
		"#{session_name}\t#{session_windows} window(s)\tcreated #{t:session_created}").Output()
	if err != nil {
		fmt.Println("No active tsq sessions.")
		return
	}

	var found bool
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.HasPrefix(line, sessionPrefix) {
			if !found {
				fmt.Println("Active tsq sessions:")
				found = true
			}
			fmt.Println(" ", line)
		}
	}
	if !found {
		fmt.Println("No active tsq sessions.")
	}
}

func RunAttach(args []string) {
	var sessionName string

	if len(args) == 0 {
		out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").Output()
		if err != nil {
			fmt.Println("No active tsq sessions.")
			return
		}
		var sessions []string
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if strings.HasPrefix(line, sessionPrefix) {
				sessions = append(sessions, line)
			}
		}
		switch len(sessions) {
		case 0:
			fmt.Println("No active tsq sessions.")
			return
		case 1:
			sessionName = sessions[0]
		default:
			fmt.Println("Multiple active tsq sessions — specify one:")
			for _, s := range sessions {
				fmt.Println(" ", s)
			}
			fmt.Println("\nUsage: tsq attach <taskID>")
			return
		}
	} else {
		sessionName = sessionNameFromArg(args[0])
	}

	fmt.Printf("Attaching to %s (detach: Ctrl-b d)\n", sessionName)
	cmd := exec.Command("tmux", "attach-session", "-t", sessionName)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "error: session %q not found or tmux unavailable\n", sessionName)
		os.Exit(1)
	}
}

func RunPane(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: tsq pane <session> [--lines N]")
		os.Exit(1)
	}
	session := sessionNameFromArg(args[0])

	fs := flag.NewFlagSet("pane", flag.ContinueOnError)
	lines := fs.Int("lines", 200, "number of lines to capture from scrollback")
	fs.Parse(args[1:]) //nolint:errcheck

	out := tmuxpkg.CapturePane(session, *lines)
	if out == "" {
		fmt.Fprintf(os.Stderr, "no output captured — session %q may not exist\n", session)
		os.Exit(1)
	}
	fmt.Println(out)
}

func RunSend(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: tsq send <session> [<text>]")
		os.Exit(1)
	}
	session := sessionNameFromArg(args[0])

	if len(args) < 2 {
		if err := tmuxpkg.SendEnter(session); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if err := tmuxpkg.SendKeys(session, args[1]); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func sanitizeAgentName(s string) string { return util.Sanitize(s) }

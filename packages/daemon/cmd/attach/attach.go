package attachcmd

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// RunAttach implements `tsq send-image --task <id> <path> [--caption "..."]`,
// called by the CLI tool itself from inside its own tmux session (see the
// tsq-attach-image system skill) to send an image back to the user as part
// of its response. Mirrors RunReport's shape in cmd/hooks/hooks.go. Named
// send-image rather than "attach" to avoid colliding with the existing
// `tsq attach <session>` tmux-attach command.
func RunAttach(args []string) error {
	fs := flag.NewFlagSet("attach", flag.ContinueOnError)
	taskID := fs.String("task", "", "task ID (required)")
	caption := fs.String("caption", "", "one-line description of the image")
	port := fs.Int("port", 7374, "hooks server port")

	if err := fs.Parse(args); err != nil {
		os.Exit(1)
	}

	rest := fs.Args()
	if *taskID == "" || len(rest) == 0 {
		fmt.Fprintln(os.Stderr, "usage: tsq send-image --task <id> <path> [--caption <text>]")
		os.Exit(1)
	}
	path := rest[0]

	payload := map[string]string{
		"task_id": *taskID,
		"path":    path,
		"caption": *caption,
	}
	body, _ := json.Marshal(payload)

	url := fmt.Sprintf("http://localhost:%d/hooks/attach", *port)
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error posting attach: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	out, _ := io.ReadAll(resp.Body)
	fmt.Printf("HTTP %d: %s\n", resp.StatusCode, strings.TrimSpace(string(out)))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		os.Exit(1)
	}
	return nil
}

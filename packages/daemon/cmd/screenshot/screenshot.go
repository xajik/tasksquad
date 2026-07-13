package screenshotcmd

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/screenshot"
	tmuxpkg "github.com/tasksquad/daemon/tmux"
)

// RunScreenshot renders a tmux pane to a PNG and prints the resulting file
// path to stdout — the caller (e.g. the supervisor's CLI tool) is expected
// to view that file as an image, not read stdout as text.
func RunScreenshot(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: tsq screenshot <session> [--lines N] [--out <path>]")
		os.Exit(1)
	}
	session := tmuxpkg.NormalizeSessionName(args[0])

	fs := flag.NewFlagSet("screenshot", flag.ContinueOnError)
	lines := fs.Int("lines", 0, "lines of scrollback history to include (0 = visible pane only)")
	out := fs.String("out", "", "output PNG path (default: ~/.tasksquad/tmp/screenshots/<session>-<timestamp>.png)")
	if err := fs.Parse(args[1:]); err != nil {
		os.Exit(1)
	}

	png, err := screenshot.Capture(session, *lines)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v — session %q may not exist\n", err, session)
		os.Exit(1)
	}

	outPath := *out
	if outPath == "" {
		outPath = defaultOutputPath(session)
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0755); err != nil {
		fmt.Fprintf(os.Stderr, "error creating output dir: %v\n", err)
		os.Exit(1)
	}
	if err := os.WriteFile(outPath, png, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "error writing screenshot: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(outPath)
}

func defaultOutputPath(session string) string {
	name := fmt.Sprintf("%s-%s.png", session, time.Now().Format("20060102-150405"))
	return filepath.Join(config.DefaultDir(), "tmp", "screenshots", name)
}

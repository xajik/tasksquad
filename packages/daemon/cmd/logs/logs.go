package logscmd

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func RunLogs(args []string) {
	home, _ := os.UserHomeDir()
	logsDir := filepath.Join(home, ".tasksquad", "logs")

	switch len(args) {
	case 0:
		today := fmt.Sprintf("daemon-%s.log", nowDate())
		path := filepath.Join(logsDir, today)
		tailFile(path)

	case 1:
		agentName := args[0]
		agentLogsDir := filepath.Join(logsDir, sanitizeAgentName(agentName))
		entries, err := os.ReadDir(agentLogsDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "no logs found for agent %q (looked in %s)\n", agentName, agentLogsDir)
			os.Exit(1)
		}
		fmt.Printf("Task logs for agent %q:\n", agentName)
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".log") {
				info, _ := e.Info()
				taskID := strings.TrimSuffix(e.Name(), ".log")
				fmt.Printf("  %s  (%s)\n", taskID, info.ModTime().Format("2006-01-02 15:04:05"))
			}
		}

	default:
		agentName, taskID := args[0], args[1]
		path := filepath.Join(logsDir, sanitizeAgentName(agentName), taskID+".log")
		tailFile(path)
	}
}

func tailFile(path string) {
	f, err := os.Open(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "log not found: %s\n", path)
		os.Exit(1)
	}
	defer f.Close()
	fmt.Printf("=== %s ===\n", path)
	io.Copy(os.Stdout, f) //nolint:errcheck
}

func nowDate() string {
	out, err := exec.Command("date", "+%Y-%m-%d").Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}

func sanitizeAgentName(s string) string {
	replacer := strings.NewReplacer("/", "-", "\\", "-", "..", "")
	return replacer.Replace(s)
}

package logger

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	out     io.Writer = os.Stdout
	mu      sync.Mutex
	logsDir string
	curDay  string
)

func Init() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("get home dir: %w", err)
	}

	logsDir = filepath.Join(home, ".tasksquad", "logs")
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		return fmt.Errorf("create logs dir: %w", err)
	}

	return openFile()
}

func openFile() error {
	day := time.Now().Format("2006-01-02")
	filename := filepath.Join(logsDir, fmt.Sprintf("daemon-%s.log", day))

	f, err := os.OpenFile(filename, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		out = os.Stdout
		return err
	}

	out = io.MultiWriter(os.Stdout, f)
	curDay = day
	return nil
}

func write(level, msg string) {
	mu.Lock()
	defer mu.Unlock()

	// Rotate log file daily
	if day := time.Now().Format("2006-01-02"); day != curDay && logsDir != "" {
		openFile() //nolint:errcheck
	}

	line := fmt.Sprintf("%s [%-5s] %s\n", time.Now().Format(time.RFC3339), level, msg)
	out.Write([]byte(line)) //nolint:errcheck
}

func Info(msg string)  { write("INFO", msg) }
func Debug(msg string) { write("DEBUG", msg) }
func Warn(msg string)  { write("WARN", msg) }
func Error(msg string) { write("ERROR", msg) }

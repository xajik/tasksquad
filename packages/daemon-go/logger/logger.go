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
	logWriter  io.Writer
	logMutex   sync.Mutex
	currentDay string
)

func Init() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("failed to get home dir: %w", err)
	}

	logsDir := filepath.Join(home, ".tasksquad", "logs")
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		return fmt.Errorf("failed to create logs dir: %w", err)
	}

	logWriter = os.Stdout
	currentDay = time.Now().Format("2006-01-02")

	go rotateCheck()

	return nil
}

func rotateCheck() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		day := time.Now().Format("2006-01-02")
		if day != currentDay {
			logMutex.Lock()
			currentDay = day
			reopenFile()
			logMutex.Unlock()
		}
	}
}

func reopenFile() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}

	logsDir := filepath.Join(home, ".tasksquad", "logs")
	filename := filepath.Join(logsDir, fmt.Sprintf("daemon-%s.log", currentDay))

	file, err := os.OpenFile(filename, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}

	logWriter = io.MultiWriter(os.Stdout, file)
	return nil
}

func formatLine(level, msg string) string {
	return fmt.Sprintf("%s [%s] %s\n", time.Now().Format(time.RFC3339), level, msg)
}

func log(level, msg string) {
	logMutex.Lock()
	defer logMutex.Unlock()

	day := time.Now().Format("2006-01-02")
	if day != currentDay {
		currentDay = day
		reopenFile()
	}

	logWriter.Write([]byte(formatLine(level, msg)))
}

func Info(msg string)  { log("INFO", msg) }
func Debug(msg string) { log("DEBUG", msg) }
func Warn(msg string)  { log("WARN", msg) }
func Error(msg string) { log("ERROR", msg) }

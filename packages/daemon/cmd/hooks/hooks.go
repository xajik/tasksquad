package hookscmd

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

func RunReport(args []string) error {
	fs := flag.NewFlagSet("report", flag.ContinueOnError)
	taskID := fs.String("task", "", "task ID (required)")
	status := fs.String("status", "", "verdict: working_fine | resolved | cannot_help (required)")
	summary := fs.String("summary", "", "one-line summary (required)")
	found := fs.String("found", "", "what the terminal showed")
	action := fs.String("action", "none", "what you sent, or none")
	port := fs.Int("port", 7374, "hooks server port")

	if err := fs.Parse(args); err != nil {
		os.Exit(1)
	}

	if *taskID == "" || *status == "" || *summary == "" {
		fmt.Fprintln(os.Stderr, "usage: tsq report --task <id> --status <status> --summary <summary> [--found <found>] [--action <action>]")
		os.Exit(1)
	}

	payload := map[string]string{
		"task_id": *taskID,
		"status":  *status,
		"summary": *summary,
		"found":   *found,
		"action":  *action,
	}
	body, _ := json.Marshal(payload)

	url := fmt.Sprintf("http://localhost:%d/hooks/supervisor", *port)
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error posting report: %v\n", err)
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

func RunSkill(args []string) error {
	fs := flag.NewFlagSet("skill", flag.ContinueOnError)
	name := fs.String("name", "", "skill name, e.g. tsq-my-skill (required)")
	description := fs.String("description", "", "one-line description (required)")
	file := fs.String("file", "", "path to skill markdown file (reads stdin if omitted)")
	port := fs.Int("port", 7374, "hooks server port")

	if err := fs.Parse(args); err != nil {
		os.Exit(1)
	}

	if *name == "" || *description == "" {
		fmt.Fprintln(os.Stderr, "usage: tsq skill --name <name> --description <desc> [--file <path>]")
		os.Exit(1)
	}

	var content []byte
	var err error
	if *file != "" {
		content, err = os.ReadFile(*file)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error reading file: %v\n", err)
			os.Exit(1)
		}
	} else {
		content, err = io.ReadAll(os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error reading stdin: %v\n", err)
			os.Exit(1)
		}
	}

	payload := map[string]string{
		"name":        *name,
		"description": *description,
		"content":     string(content),
	}
	body, _ := json.Marshal(payload)

	url := fmt.Sprintf("http://localhost:%d/hooks/skill", *port)
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error pushing skill: %v\n", err)
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

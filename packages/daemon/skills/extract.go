package skills

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/tasksquad/daemon/api"
	"github.com/tasksquad/daemon/auth"
	"github.com/tasksquad/daemon/config"
	"github.com/tasksquad/daemon/logger"
)

// ExtractFromSession is called after a daemon session closes.
// It invokes the CLI tool with a structured prompt to extract reusable learnings
// as skills, then POSTs them to /daemon/skills.
// Safe to call in a goroutine — logs errors and returns silently.
func ExtractFromSession(cfg *config.Config, agentID, tmuxCapture string) {
	if cfg == nil || agentID == "" || tmuxCapture == "" {
		return
	}

	// Trim to last 8000 chars to stay within context limits.
	capture := tmuxCapture
	if len(capture) > 8000 {
		capture = capture[len(capture)-8000:]
	}

	cli := detectCLI()
	if cli == "" {
		logger.Warn("[skills] No CLI tool found — skipping skill extraction")
		return
	}

	prompt := buildExtractionPrompt(capture)
	output, err := runCLI(cli, prompt, 60*time.Second)
	if err != nil {
		logger.Warn(fmt.Sprintf("[skills] CLI extraction failed: %v", err))
		return
	}

	payload, err := parseSkillsResponse(output)
	if err != nil || len(payload.Skills) == 0 {
		logger.Debug("[skills] No new skills from session")
		return
	}

	token, err := auth.GetToken(cfg.Firebase.APIKey, cfg.Server.URL)
	if err != nil {
		logger.Error(fmt.Sprintf("[skills] Auth failed: %v", err))
		return
	}

	for _, s := range payload.Skills {
		if s.Name == "" || s.Content == "" {
			continue
		}
		if !strings.HasPrefix(s.Name, "tsq-") {
			logger.Warn(fmt.Sprintf("[skills] Skipping %q — name must start with tsq-", s.Name))
			continue
		}
		_, err := api.Post(cfg, token, agentID, "/daemon/skills", map[string]any{
			"name":        s.Name,
			"description": s.Description,
			"content":     s.Content,
		})
		if err != nil {
			logger.Error(fmt.Sprintf("[skills] Failed to upload %q: %v", s.Name, err))
		} else {
			logger.Info(fmt.Sprintf("[skills] Uploaded skill %q", s.Name))
		}
	}
}

// buildExtractionPrompt returns the prompt sent to the CLI tool after a session.
func buildExtractionPrompt(sessionOutput string) string {
	return fmt.Sprintf(`Review the following agent session output.

Your task: identify if the session contains any reusable learning that would help future agents avoid mistakes or solve recurring problems. Focus on:
- Non-obvious fixes or workarounds discovered during the task
- Tool usage patterns that were tricky to figure out
- Specific steps required to solve a repeated problem

If you identify useful learnings, produce skills. If the session was routine or trivial, respond with an empty list.

Each skill content must follow this format with YAML frontmatter:
---
name: tsq-<kebab-case-name>
description: <one-line description>
---

<step-by-step instructions>

Rules:
- All skill names MUST start with "tsq-"
- Only create skills for non-trivial, reusable learnings
- Do not create skills for one-off tasks
- Keep content concise but actionable

Respond ONLY with valid JSON in this exact shape — no other text:
{"skills": [{"name": "tsq-example", "description": "...", "content": "---\nname: tsq-example\ndescription: ...\n---\n\n..."}]}

If there are no new learnings, respond with:
{"skills": []}

Session output:
%s`, sessionOutput)
}

// parseSkillsResponse extracts the JSON payload from CLI output.
// The CLI may produce preamble text before the JSON.
func parseSkillsResponse(output string) (skillPayload, error) {
	start := strings.Index(output, `{"skills"`)
	if start < 0 {
		start = strings.Index(output, "{")
	}
	end := strings.LastIndex(output, "}")
	if start < 0 || end <= start {
		return skillPayload{}, fmt.Errorf("no JSON found")
	}
	var p skillPayload
	if err := json.Unmarshal([]byte(output[start:end+1]), &p); err != nil {
		return skillPayload{}, err
	}
	return p, nil
}

// runCLI executes the CLI binary with -p <prompt> and returns stdout.
// Uses --dangerously-skip-permissions to avoid interactive prompts.
func runCLI(cli, prompt string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, cli, "--dangerously-skip-permissions", "-p", prompt)
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && len(exitErr.Stderr) > 0 {
			return "", fmt.Errorf("%w: %s", err, exitErr.Stderr)
		}
		return "", err
	}
	return string(out), nil
}

// detectCLI returns the path of the first available CLI tool, or "".
func detectCLI() string {
	for _, name := range []string{"claude", "gemini", "opencode", "codex"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return ""
}

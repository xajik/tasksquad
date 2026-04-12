// Package harness defines the on-disk directories used by each AI CLI agent
// harness (Claude Code, Gemini, Codex, etc.) to load skills and sub-agents.
package harness

import (
	"io"
	"os"
	"path/filepath"
)

// All is the canonical list of harness base directories, relative to the
// agent's work directory. Each maps to a different AI CLI ecosystem:
//
//	.claude — Claude Code, OpenCode
//	.agents — Gemini, Codex
//	.agent  — Claw Code
//	.gemini — Gemini CLI
var All = []string{".claude", ".agents", ".agent", ".gemini"}

// SkillDirs returns the on-disk skill directories for all harnesses under workDir.
func SkillDirs(workDir string) []string {
	return subDirs(workDir, "skills")
}

// AgentDirs returns the on-disk sub-agent directories for all harnesses under workDir.
func AgentDirs(workDir string) []string {
	return subDirs(workDir, "agents")
}

func subDirs(workDir, sub string) []string {
	dirs := make([]string, len(All))
	for i, p := range All {
		dirs[i] = filepath.Join(workDir, p, sub)
	}
	return dirs
}

// CopyFile copies a single file from src to dst, creating or overwriting dst.
func CopyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}

// FileExists reports whether path exists on disk.
func FileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// Package harness defines the on-disk directories used by each AI CLI agent
// harness (Claude Code, Gemini, Codex, etc.) to load skills, sub-agents, and commands.
package harness

import (
	"io"
	"os"
	"path/filepath"
)

// All is the canonical list of harness base directories, relative to the
// agent's work directory. Each maps to a different AI CLI ecosystem:
//
//	.claude — Claude Code
//	.agents — Gemini, Codex
//	.agent  — Claw Code
//	.gemini — Gemini CLI
//	.pi     — Pi (pi.dev)
//	.forge  — Forge
var All = []string{".claude", ".agents", ".agent", ".gemini", ".pi", ".forge"}

// CommandBases is the list of harness base directories that support slash
// commands. OpenCode, Pi, and Forge are included here (they use .opencode/commands/,
// .pi/commands/, and .forge/commands/ respectively) but use TypeScript plugins for hook delivery.
var CommandBases = []string{".claude", ".agents", ".agent", ".gemini", ".opencode", ".pi", ".forge"}

// SkillDirs returns the on-disk skill directories for all harnesses under workDir.
func SkillDirs(workDir string) []string {
	return subDirs(workDir, All, "skills")
}

// AgentDirs returns the on-disk sub-agent directories for all harnesses under workDir.
func AgentDirs(workDir string) []string {
	return subDirs(workDir, All, "agents")
}

// CommandDirs returns the on-disk command directories for all harnesses under
// workDir. This includes .opencode/commands/ in addition to the standard set.
func CommandDirs(workDir string) []string {
	return subDirs(workDir, CommandBases, "commands")
}

func subDirs(workDir string, bases []string, sub string) []string {
	dirs := make([]string, len(bases))
	for i, p := range bases {
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

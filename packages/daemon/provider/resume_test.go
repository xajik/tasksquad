package provider

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

const testResumeID = "6f75c202-a633-4804-8b23-5937aa47f17f"

func TestValidResumeID(t *testing.T) {
	for id, want := range map[string]bool{
		testResumeID:                     true,
		"01a14e55-4b15-7600-9b0b-ea0c89": true,
		"":                               false,
		"--dangerously-skip-permissions": false,
		"-x":                             false,
		"a b":                            false,
		"../../etc/passwd":               false,
		"a..b":                           false,
		"a/b":                            false,
	} {
		if got := ValidResumeID(id); got != want {
			t.Errorf("ValidResumeID(%q) = %v, want %v", id, got, want)
		}
	}
}

func TestClaudeResumeArgs(t *testing.T) {
	args := []string{"--model", "opus", "--settings", "{}"}
	got := (&ClaudeCode{}).ResumeArgs(args, testResumeID)
	want := []string{"--model", "opus", "--settings", "{}", "--resume", testResumeID}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if len(args) != 4 {
		t.Fatalf("ResumeArgs mutated its input: %v", args)
	}
}

func TestCodexResumeArgs(t *testing.T) {
	p := &Codex{}
	args := append(p.ExtraArgs(), p.SetupArgs(4242, "agent", "task")...)
	args = p.ResumeArgs(args, testResumeID)
	// The initial prompt is appended after ResumeArgs, as in startTask.
	args = append(args, p.InitialPromptArgs("hello")...)
	if args[0] != "resume" {
		t.Fatalf("resume must be the subcommand, got %v", args)
	}
	n := len(args)
	if args[n-3] != testResumeID || args[n-2] != "--" || args[n-1] != "hello" {
		t.Fatalf("want `<id> -- <prompt>` at the end, got %v", args[n-3:])
	}
}

func TestClaudeCanResume(t *testing.T) {
	root := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", root)
	p := &ClaudeCode{}
	if p.CanResume("", "", testResumeID) {
		t.Fatal("empty store must not resume")
	}
	dir := filepath.Join(root, "projects", "-Users-me-repo")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, testResumeID+".jsonl"), []byte("{}\n"), 0o644)
	if !p.CanResume("", "", testResumeID) {
		t.Fatal("session in the store must resume")
	}
	if p.CanResume("", "", "*") {
		t.Fatal("a glob pattern must not match")
	}
}

func TestCodexCanResume(t *testing.T) {
	root := t.TempDir()
	t.Setenv("CODEX_HOME", root)
	p := &Codex{}
	if p.CanResume("", "", testResumeID) {
		t.Fatal("missing store must not resume")
	}
	dir := filepath.Join(root, "sessions", "2026", "10", "18")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "rollout-2026-10-18T17-26-15-"+testResumeID+".jsonl"), []byte("{}\n"), 0o644)
	if !p.CanResume("", "", testResumeID) {
		t.Fatal("rollout in the store must resume")
	}
	if p.CanResume("", "", "5937aa47f17f") {
		t.Fatal("a partial id must not match")
	}
}

func TestResumableProviders(t *testing.T) {
	for name, factory := range registry {
		_, ok := factory().(Resumer)
		want := name != "stdout" && name != "claw"
		if ok != want {
			t.Errorf("%s: Resumer = %v, want %v", name, ok, want)
		}
	}
}

func TestGeminiResume(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	p := &Gemini{}
	if got := p.ResumeArgs([]string{"-m", "x"}, testResumeID); !reflect.DeepEqual(got, []string{"-m", "x", "--resume", testResumeID}) {
		t.Fatalf("got %v", got)
	}
	if p.CanResume("", "", testResumeID) {
		t.Fatal("missing store must not resume")
	}
	chats := filepath.Join(home, ".gemini", "tmp", "0123abcd", "chats")
	os.MkdirAll(chats, 0o755)
	// File names carry only part of the UUID; the contents name the session.
	os.WriteFile(filepath.Join(chats, "session-2026-10-28T09-00-6f75c202.json"),
		[]byte(`{"sessionId": "`+testResumeID+`", "messages": []}`), 0o644)
	if !p.CanResume("", "", testResumeID) {
		t.Fatal("chat file recording the session must resume")
	}
	if p.CanResume("", "", "6f75c202") {
		t.Fatal("a partial id must not match")
	}
}

func TestOpenCodeResume(t *testing.T) {
	const id = "ses_f07f24b9affeNBpP0gLeMlv0Zj"
	p := &OpenCode{}
	if got := p.ResumeArgs([]string{"--print-logs"}, id); !reflect.DeepEqual(got, []string{"--print-logs", "--session", id}) {
		t.Fatalf("got %v", got)
	}
	// A stand-in CLI that lists one session, only when run in the project dir.
	dir := t.TempDir()
	project := filepath.Join(dir, "project")
	os.MkdirAll(project, 0o755)
	bin := filepath.Join(dir, "opencode")
	script := "#!/bin/sh\n[ \"$1 $2 $3 $4\" = \"session list --format json\" ] || exit 2\n" +
		"[ \"$PWD\" = \"" + project + "\" ] || { echo '[]'; exit 0; }\n" +
		"echo '[{\"id\":\"" + id + "\",\"directory\":\"" + project + "\"}]'\n"
	os.WriteFile(bin, []byte(script), 0o755)
	if !p.CanResume(bin+" --print-logs", project, id) {
		t.Fatal("session listed for the project must resume")
	}
	if p.CanResume(bin, dir, id) {
		t.Fatal("another project's listing must not resume")
	}
	if p.CanResume(filepath.Join(dir, "missing"), project, id) {
		t.Fatal("a CLI that can't run must not resume")
	}
	if openCodeListHas([]byte("not json"), id) || openCodeListHas([]byte(`[{"id":"ses_other"}]`), id) {
		t.Fatal("unexpected match")
	}
}

func TestPiResume(t *testing.T) {
	const id = "01a1807b-d4cf-732f-a57d-cc9414b962bd"
	p := &Pi{}
	got := p.ResumeArgs([]string{"--model", "x", "-p", "follow up"}, id)
	if want := []string{"--session", id, "--model", "x", "-p", "follow up"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PI_CODING_AGENT_DIR", "")
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", "")
	repo := filepath.Join(home, "repo")
	os.MkdirAll(repo, 0o755)
	if p.CanResume("", repo, id) {
		t.Fatal("missing store must not resume")
	}
	dir := filepath.Join(home, ".pi", "agent", "sessions", "--repo--")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "2026-10-28T03-00-00-000Z_"+id+".jsonl"),
		[]byte(`{"type":"session","version":3,"id":"`+id+`","cwd":"`+repo+`"}`+"\n{}\n"), 0o644)
	if !p.CanResume("", repo, id) {
		t.Fatal("session file recorded for the work dir must resume")
	}
	if p.CanResume("", home, id) {
		t.Fatal("a session from another directory must not resume (Pi would ask to fork it)")
	}
	if p.CanResume("", repo, "cc9414b962bd") {
		t.Fatal("a partial id must not match")
	}
	custom := t.TempDir()
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", custom)
	if p.CanResume("", repo, id) {
		t.Fatal("PI_CODING_AGENT_SESSION_DIR replaces the default store")
	}
}

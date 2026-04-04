package skills

import (
	"strings"
	"testing"
)

// ── parseSkillsResponse ───────────────────────────────────────────────────────

func TestParseSkillsResponse_ValidJSON(t *testing.T) {
	input := `{"skills":[{"name":"tsq-foo","description":"does foo","content":"---\nname: tsq-foo\n---\nsteps"}]}`
	p, err := parseSkillsResponse(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(p.Skills) != 1 {
		t.Fatalf("expected 1 skill, got %d", len(p.Skills))
	}
	if p.Skills[0].Name != "tsq-foo" {
		t.Errorf("Name = %q, want tsq-foo", p.Skills[0].Name)
	}
}

func TestParseSkillsResponse_EmptyList(t *testing.T) {
	p, err := parseSkillsResponse(`{"skills":[]}`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(p.Skills) != 0 {
		t.Errorf("expected 0 skills, got %d", len(p.Skills))
	}
}

func TestParseSkillsResponse_PreambleBeforeJSON(t *testing.T) {
	// CLI often prints preamble text before the JSON.
	input := "Here are the learnings I found:\n\n" + `{"skills":[{"name":"tsq-bar","description":"bar","content":"x"}]}`
	p, err := parseSkillsResponse(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(p.Skills) != 1 || p.Skills[0].Name != "tsq-bar" {
		t.Errorf("failed to parse after preamble: %+v", p)
	}
}

func TestParseSkillsResponse_NoJSON(t *testing.T) {
	_, err := parseSkillsResponse("no json here at all")
	if err == nil {
		t.Error("expected error for input with no JSON")
	}
}

func TestParseSkillsResponse_MalformedJSON(t *testing.T) {
	_, err := parseSkillsResponse(`{"skills": [broken}`)
	if err == nil {
		t.Error("expected error for malformed JSON")
	}
}

// ── buildExtractionPrompt ─────────────────────────────────────────────────────

func TestBuildExtractionPrompt_ContainsSessionOutput(t *testing.T) {
	sessionOut := "some terminal output from the agent"
	prompt := buildExtractionPrompt(sessionOut)
	if !strings.Contains(prompt, sessionOut) {
		t.Error("prompt should contain the session output")
	}
}

func TestBuildExtractionPrompt_ContainsRequiredRules(t *testing.T) {
	prompt := buildExtractionPrompt("output")
	for _, must := range []string{"tsq-", `{"skills"`, "YAML frontmatter"} {
		if !strings.Contains(prompt, must) {
			t.Errorf("prompt missing required content %q", must)
		}
	}
}

// ── remoteSkillFromMap ────────────────────────────────────────────────────────

func TestRemoteSkillFromMap_AllFields(t *testing.T) {
	m := map[string]any{
		"id":           "skill-123",
		"team_id":      "team-456",
		"name":         "tsq-test",
		"description":  "A test skill",
		"content":      "step 1\nstep 2",
		"etag":         "abc123",
		"auto_install": float64(1),
		"is_default":   float64(0),
		"version":      float64(3),
	}
	s := remoteSkillFromMap(m)

	if s.ID != "skill-123" {
		t.Errorf("ID = %q", s.ID)
	}
	if s.Name != "tsq-test" {
		t.Errorf("Name = %q", s.Name)
	}
	if s.AutoInstall != 1 {
		t.Errorf("AutoInstall = %d", s.AutoInstall)
	}
	if s.IsDefault != 0 {
		t.Errorf("IsDefault = %d", s.IsDefault)
	}
	if s.Version != 3 {
		t.Errorf("Version = %d", s.Version)
	}
}

func TestRemoteSkillFromMap_MissingFieldsAreZero(t *testing.T) {
	s := remoteSkillFromMap(map[string]any{"name": "tsq-minimal"})
	if s.Name != "tsq-minimal" {
		t.Errorf("Name = %q", s.Name)
	}
	if s.AutoInstall != 0 || s.IsDefault != 0 || s.Version != 0 {
		t.Error("missing numeric fields should be zero")
	}
}

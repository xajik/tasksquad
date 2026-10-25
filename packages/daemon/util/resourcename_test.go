package util

import "testing"

func TestValidResourceName(t *testing.T) {
	for _, name := range []string{"tsq-cleanup", "code-review", "Planner_v2", "x"} {
		if !ValidResourceName(name) {
			t.Errorf("ValidResourceName(%q) = false, want true", name)
		}
	}
	for _, name := range []string{"", ".", "..", "../x", "a/b", `a\b`, "a.b", ".hidden", "-flag", "a b", "a\x00b", string(make([]byte, 101))} {
		if ValidResourceName(name) {
			t.Errorf("ValidResourceName(%q) = true, want false", name)
		}
	}
}

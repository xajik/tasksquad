package supervisor

import "testing"

func TestSafeIDRe(t *testing.T) {
	valid := []string{
		"01JQZF3XKBP5TYNQWN6KV3M8AZ", // typical ULID
		"abc123",
		"ABC-def_123",
		"a",
		"01234567890123456789012345678901", // 32 chars
	}
	for _, id := range valid {
		if !safeIDRe.MatchString(id) {
			t.Errorf("expected %q to be accepted", id)
		}
	}

	invalid := []string{
		"",
		"has space",
		`has"quote`,
		"has;semicolon",
		"has&ampersand",
		"has|pipe",
		"has`backtick",
		"has$dollar",
		"has(paren",
		"has\nnewline",
		"123456789012345678901234567890123", // 33 chars — over limit
	}
	for _, id := range invalid {
		if safeIDRe.MatchString(id) {
			t.Errorf("expected %q to be rejected", id)
		}
	}
}

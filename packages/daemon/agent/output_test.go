package agent

import "testing"

func TestCleanLine_StripANSI(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"\x1b[32mHello\x1b[0m", "Hello"},
		{"\x1b[1;33mWarning\x1b[0m", "Warning"},
		{"no escapes", "no escapes"},
		{"", ""},
		{"\x1b[2J\x1b[H", ""},          // clear screen sequences
		{"\x1b]0;title\x07normal", "normal"}, // OSC title sequence
	}
	for _, tc := range cases {
		got := cleanLine(tc.input)
		if got != tc.want {
			t.Errorf("cleanLine(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestCleanLine_CarriageReturn(t *testing.T) {
	// \r overwrite: only text after last \r is kept
	got := cleanLine("overwritten\rfinal")
	if got != "final" {
		t.Errorf("got %q, want %q", got, "final")
	}
}

func TestCleanLine_CarriageReturnWithANSI(t *testing.T) {
	got := cleanLine("\x1b[32mred\x1b[0m\rfinal")
	if got != "final" {
		t.Errorf("got %q, want %q", got, "final")
	}
}

func TestCleanLine_TrailingSpacesTrimmed(t *testing.T) {
	got := cleanLine("hello   \t")
	if got != "hello" {
		t.Errorf("got %q, want %q", got, "hello")
	}
}

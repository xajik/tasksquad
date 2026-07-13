package screenshot

import (
	"image/color"
	"testing"
)

func TestParseGrid_PlainText(t *testing.T) {
	grid := parseGrid("hi", 4)
	if len(grid) != 1 || len(grid[0]) != 4 {
		t.Fatalf("expected 1 row of 4 cols, got %d rows of %d cols", len(grid), len(grid[0]))
	}
	want := []rune{'h', 'i', ' ', ' '}
	for i, r := range want {
		if grid[0][i].r != r {
			t.Errorf("cell %d: got %q, want %q", i, grid[0][i].r, r)
		}
		if grid[0][i].fg != defaultFG || grid[0][i].bg != defaultBG {
			t.Errorf("cell %d: expected default colors, got fg=%v bg=%v", i, grid[0][i].fg, grid[0][i].bg)
		}
	}
}

func TestParseGrid_BasicColorAndReset(t *testing.T) {
	grid := parseGrid("\x1b[31mred\x1b[0mok", 8)
	row := grid[0]
	for i := range 3 {
		if row[i].fg != ansi16[1] {
			t.Errorf("cell %d: expected red fg %v, got %v", i, ansi16[1], row[i].fg)
		}
	}
	for i := 3; i < 5; i++ {
		if row[i].fg != defaultFG {
			t.Errorf("cell %d: expected default fg after reset, got %v", i, row[i].fg)
		}
	}
}

func TestParseGrid_Bold(t *testing.T) {
	grid := parseGrid("\x1b[1mB\x1b[22mN", 2)
	row := grid[0]
	if !row[0].bold {
		t.Errorf("expected cell 0 bold=true")
	}
	if row[1].bold {
		t.Errorf("expected cell 1 bold=false after SGR 22")
	}
}

func TestParseGrid_Reverse(t *testing.T) {
	grid := parseGrid("\x1b[7mR", 1)
	if !grid[0][0].reverse {
		t.Errorf("expected reverse=true")
	}
}

func TestParseGrid_Underline(t *testing.T) {
	grid := parseGrid("\x1b[4mU\x1b[24mN", 2)
	if !grid[0][0].underline {
		t.Errorf("expected cell 0 underline=true")
	}
	if grid[0][1].underline {
		t.Errorf("expected cell 1 underline=false after SGR 24")
	}
}

func TestParseGrid_256Color(t *testing.T) {
	grid := parseGrid("\x1b[38;5;208mX", 1)
	want := color256(208)
	if grid[0][0].fg != want {
		t.Errorf("expected 256-color fg %v, got %v", want, grid[0][0].fg)
	}
}

func TestParseGrid_TrueColor(t *testing.T) {
	grid := parseGrid("\x1b[38;2;10;20;30mX", 1)
	want := color.RGBA{10, 20, 30, 0xFF}
	if grid[0][0].fg != want {
		t.Errorf("expected truecolor fg %v, got %v", want, grid[0][0].fg)
	}
}

func TestParseGrid_BackgroundColor(t *testing.T) {
	grid := parseGrid("\x1b[44mX", 1)
	if grid[0][0].bg != ansi16[4] {
		t.Errorf("expected blue bg %v, got %v", ansi16[4], grid[0][0].bg)
	}
}

func TestParseGrid_StateCarriesAcrossLines(t *testing.T) {
	// No reset before the newline — bold should still apply on line 2.
	grid := parseGrid("\x1b[1mA\nB", 2)
	if len(grid) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(grid))
	}
	if !grid[0][0].bold {
		t.Errorf("expected line 1 cell bold=true")
	}
	if !grid[1][0].bold {
		t.Errorf("expected bold state to carry onto line 2")
	}
}

func TestParseGrid_ShortLinePaddedWithDefaultBG(t *testing.T) {
	// Even with an active background color, unwritten cells at the end of
	// a short line should use the terminal's default background, matching
	// how tmux trims trailing whitespace off a line that was never colored.
	grid := parseGrid("\x1b[44mX", 4)
	for i := 1; i < 4; i++ {
		if grid[0][i].bg != defaultBG {
			t.Errorf("cell %d: expected default bg padding, got %v", i, grid[0][i].bg)
		}
	}
}

func TestColor256_Palette(t *testing.T) {
	cases := []struct {
		idx  int
		want color.RGBA
	}{
		{0, ansi16[0]},
		{15, ansi16[15]},
		{16, color.RGBA{0, 0, 0, 0xFF}},        // start of color cube (black)
		{231, color.RGBA{255, 255, 255, 0xFF}}, // end of color cube (white)
		{232, color.RGBA{8, 8, 8, 0xFF}},       // start of grayscale ramp
		{255, color.RGBA{238, 238, 238, 0xFF}}, // end of grayscale ramp
	}
	for _, c := range cases {
		got := color256(c.idx)
		if got != c.want {
			t.Errorf("color256(%d) = %v, want %v", c.idx, got, c.want)
		}
	}
}

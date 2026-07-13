package screenshot

import (
	"image/color"
	"strconv"
	"strings"
)

// defaultFG and defaultBG approximate a standard dark-theme terminal palette.
var (
	defaultFG = color.RGBA{0xD4, 0xD4, 0xD4, 0xFF}
	defaultBG = color.RGBA{0x0C, 0x0C, 0x0C, 0xFF}
)

// ansi16 is the classic xterm 16-color palette (indices 0-15: normal 0-7,
// bright 8-15).
var ansi16 = [16]color.RGBA{
	{0x00, 0x00, 0x00, 0xFF}, {0xCD, 0x00, 0x00, 0xFF}, {0x00, 0xCD, 0x00, 0xFF}, {0xCD, 0xCD, 0x00, 0xFF},
	{0x00, 0x00, 0xEE, 0xFF}, {0xCD, 0x00, 0xCD, 0xFF}, {0x00, 0xCD, 0xCD, 0xFF}, {0xE5, 0xE5, 0xE5, 0xFF},
	{0x7F, 0x7F, 0x7F, 0xFF}, {0xFF, 0x00, 0x00, 0xFF}, {0x00, 0xFF, 0x00, 0xFF}, {0xFF, 0xFF, 0x00, 0xFF},
	{0x5C, 0x5C, 0xFF, 0xFF}, {0xFF, 0x00, 0xFF, 0xFF}, {0x00, 0xFF, 0xFF, 0xFF}, {0xFF, 0xFF, 0xFF, 0xFF},
}

// color256 resolves an xterm 256-color palette index to an RGB color:
// 0-15 the standard palette, 16-231 a 6x6x6 color cube, 232-255 a
// grayscale ramp.
func color256(i int) color.RGBA {
	switch {
	case i < 16:
		return ansi16[i]
	case i < 232:
		i -= 16
		return color.RGBA{cubeLevel(i / 36), cubeLevel((i / 6) % 6), cubeLevel(i % 6), 0xFF}
	default:
		v := uint8(8 + 10*(i-232))
		return color.RGBA{v, v, v, 0xFF}
	}
}

func cubeLevel(n int) uint8 {
	if n == 0 {
		return 0
	}
	return uint8(55 + 40*n)
}

// cell is one character position in the rendered terminal grid.
type cell struct {
	r         rune
	fg, bg    color.RGBA
	bold      bool
	dim       bool
	underline bool
	reverse   bool
	strike    bool
}

// sgrState tracks the current SGR (Select Graphic Rendition) attributes
// while scanning the captured pane text.
type sgrState struct {
	fg, bg             color.RGBA
	bold, dim          bool
	underline, reverse bool
	strike             bool
}

func newSGRState() sgrState {
	return sgrState{fg: defaultFG, bg: defaultBG}
}

func (s *sgrState) cell(r rune) cell {
	return cell{r: r, fg: s.fg, bg: s.bg, bold: s.bold, dim: s.dim, underline: s.underline, reverse: s.reverse, strike: s.strike}
}

// apply updates state in place for one SGR "m" sequence's already
// semicolon-split parameters.
func (s *sgrState) apply(params []string) {
	if len(params) == 0 {
		params = []string{"0"}
	}
	for i := 0; i < len(params); i++ {
		p, _ := strconv.Atoi(params[i])
		switch {
		case p == 0:
			*s = newSGRState()
		case p == 1:
			s.bold = true
		case p == 2:
			s.dim = true
		case p == 4:
			s.underline = true
		case p == 7:
			s.reverse = true
		case p == 9:
			s.strike = true
		case p == 22:
			s.bold, s.dim = false, false
		case p == 24:
			s.underline = false
		case p == 27:
			s.reverse = false
		case p == 29:
			s.strike = false
		case p >= 30 && p <= 37:
			s.fg = ansi16[p-30]
		case p == 38:
			c, consumed := parseExtendedColor(params[i+1:])
			s.fg = c
			i += consumed
		case p == 39:
			s.fg = defaultFG
		case p >= 40 && p <= 47:
			s.bg = ansi16[p-40]
		case p == 48:
			c, consumed := parseExtendedColor(params[i+1:])
			s.bg = c
			i += consumed
		case p == 49:
			s.bg = defaultBG
		case p >= 90 && p <= 97:
			s.fg = ansi16[8+p-90]
		case p >= 100 && p <= 107:
			s.bg = ansi16[8+p-100]
		}
	}
}

// parseExtendedColor parses the parameters following a 38 or 48 SGR code,
// handling both "5;N" (256-color) and "2;r;g;b" (truecolor) forms. It
// returns the resolved color and how many extra parameters it consumed
// (so the caller can skip over them).
func parseExtendedColor(rest []string) (color.RGBA, int) {
	if len(rest) == 0 {
		return defaultFG, 0
	}
	mode, _ := strconv.Atoi(rest[0])
	switch mode {
	case 5:
		if len(rest) < 2 {
			return defaultFG, 1
		}
		n, _ := strconv.Atoi(rest[1])
		return color256(n), 2
	case 2:
		if len(rest) < 4 {
			return defaultFG, len(rest)
		}
		r, _ := strconv.Atoi(rest[1])
		g, _ := strconv.Atoi(rest[2])
		b, _ := strconv.Atoi(rest[3])
		return color.RGBA{uint8(r), uint8(g), uint8(b), 0xFF}, 4
	default:
		return defaultFG, 1
	}
}

// parseGrid scans raw ANSI text (as produced by `tmux capture-pane -e`)
// into a fixed-width grid of styled cells. SGR state is carried across the
// whole blob rather than reset per line, since tmux is not guaranteed to
// re-emit full state at every line boundary.
func parseGrid(raw string, cols int) [][]cell {
	var rows [][]cell
	row := make([]cell, 0, cols)
	state := newSGRState()

	runes := []rune(raw)
	for i := 0; i < len(runes); i++ {
		switch c := runes[i]; c {
		case '\x1b':
			if i+1 < len(runes) && runes[i+1] == '[' {
				j := i + 2
				start := j
				for j < len(runes) && !(runes[j] >= 0x40 && runes[j] <= 0x7E) {
					j++
				}
				if j < len(runes) {
					if runes[j] == 'm' {
						state.apply(strings.Split(string(runes[start:j]), ";"))
					}
					i = j
					continue
				}
				// Unterminated sequence — stop scanning.
				i = len(runes)
				continue
			}
			// Non-CSI escape (e.g. OSC) — skip the ESC byte defensively.
			continue
		case '\r':
			continue
		case '\n':
			rows = append(rows, padRow(row, cols))
			row = make([]cell, 0, cols)
		default:
			if len(row) < cols {
				row = append(row, state.cell(c))
			}
		}
	}
	rows = append(rows, padRow(row, cols))
	return rows
}

// padRow pads a short row (tmux trims trailing whitespace) out to cols with
// default-background blank cells, matching how a real terminal leaves
// untouched screen space in its default background color.
func padRow(row []cell, cols int) []cell {
	for len(row) < cols {
		row = append(row, cell{r: ' ', fg: defaultFG, bg: defaultBG})
	}
	return row
}

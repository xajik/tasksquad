package screenshot

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"

	"golang.org/x/image/font"
	"golang.org/x/image/math/fixed"
)

// renderPNG draws a grid of styled cells into a PNG image using the
// embedded monospace font faces, one glyph per cell.
func renderPNG(grid [][]cell) ([]byte, error) {
	rows := len(grid)
	cols := 0
	if rows > 0 {
		cols = len(grid[0])
	}
	if rows == 0 || cols == 0 {
		grid = [][]cell{{{r: ' ', fg: defaultFG, bg: defaultBG}}}
		rows, cols = 1, 1
	}

	img := image.NewRGBA(image.Rect(0, 0, cols*cellWidth, rows*cellHeight))

	for y, row := range grid {
		for x, c := range row {
			_, bg := resolveDrawColors(c)
			rect := image.Rect(x*cellWidth, y*cellHeight, (x+1)*cellWidth, (y+1)*cellHeight)
			draw.Draw(img, rect, image.NewUniform(bg), image.Point{}, draw.Src)
		}
	}

	for y, row := range grid {
		baseline := y*cellHeight + cellAscent
		for x, c := range row {
			if c.r == 0 || c.r == ' ' {
				continue
			}
			fg, _ := resolveDrawColors(c)
			face := regularFace
			if c.bold {
				face = boldFace
			}
			(&font.Drawer{
				Dst:  img,
				Src:  image.NewUniform(fg),
				Face: face,
				Dot:  fixed.P(x*cellWidth, baseline),
			}).DrawString(string(c.r))

			if c.underline {
				drawHLine(img, x*cellWidth, (x+1)*cellWidth, baseline+2, fg)
			}
			if c.strike {
				drawHLine(img, x*cellWidth, (x+1)*cellWidth, y*cellHeight+cellHeight/2, fg)
			}
		}
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// resolveDrawColors applies reverse-video and dim adjustments to a cell's
// stored colors, returning the colors that should actually be drawn.
func resolveDrawColors(c cell) (fg, bg color.RGBA) {
	fg, bg = c.fg, c.bg
	if c.reverse {
		fg, bg = bg, fg
	}
	if c.dim {
		fg = dimColor(fg)
	}
	return fg, bg
}

func dimColor(c color.RGBA) color.RGBA {
	return color.RGBA{
		R: uint8(float64(c.R) * 0.6),
		G: uint8(float64(c.G) * 0.6),
		B: uint8(float64(c.B) * 0.6),
		A: c.A,
	}
}

func drawHLine(img *image.RGBA, x0, x1, y int, c color.RGBA) {
	for x := x0; x < x1; x++ {
		img.Set(x, y, c)
	}
}

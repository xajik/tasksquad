package screenshot

import (
	"bytes"
	"image/png"
	"testing"
)

func TestRenderPNG_Dimensions(t *testing.T) {
	grid := parseGrid("hi\nyo", 2)
	out, err := renderPNG(grid)
	if err != nil {
		t.Fatalf("renderPNG: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("decode PNG: %v", err)
	}
	b := img.Bounds()
	if b.Dx() != 2*cellWidth || b.Dy() != 2*cellHeight {
		t.Errorf("got %dx%d, want %dx%d", b.Dx(), b.Dy(), 2*cellWidth, 2*cellHeight)
	}
}

func TestRenderPNG_EmptyGrid(t *testing.T) {
	out, err := renderPNG(nil)
	if err != nil {
		t.Fatalf("renderPNG(nil): %v", err)
	}
	if _, err := png.Decode(bytes.NewReader(out)); err != nil {
		t.Fatalf("decode PNG: %v", err)
	}
}

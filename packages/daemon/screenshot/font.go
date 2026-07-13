package screenshot

import (
	_ "embed"
	"fmt"

	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
)

//go:embed assets/JetBrainsMono-Regular.ttf
var regularTTF []byte

//go:embed assets/JetBrainsMono-Bold.ttf
var boldTTF []byte

const (
	fontSize = 16.0
	fontDPI  = 72.0
)

// regularFace, boldFace and the fixed per-glyph cell dimensions are set
// once at package init from the embedded JetBrains Mono font files.
var (
	regularFace                       font.Face
	boldFace                          font.Face
	cellWidth, cellHeight, cellAscent int
)

func init() {
	var err error
	regularFace, cellWidth, cellHeight, cellAscent, err = loadFace(regularTTF)
	if err != nil {
		panic(fmt.Sprintf("screenshot: failed to load embedded regular font: %v", err))
	}
	boldFace, _, _, _, err = loadFace(boldTTF)
	if err != nil {
		panic(fmt.Sprintf("screenshot: failed to load embedded bold font: %v", err))
	}
}

// loadFace parses an embedded TTF and returns a ready-to-use face along
// with the fixed cell dimensions (in pixels) every glyph is drawn into.
func loadFace(ttf []byte) (face font.Face, width, height, ascent int, err error) {
	f, err := opentype.Parse(ttf)
	if err != nil {
		return nil, 0, 0, 0, err
	}
	face, err = opentype.NewFace(f, &opentype.FaceOptions{
		Size:    fontSize,
		DPI:     fontDPI,
		Hinting: font.HintingFull,
	})
	if err != nil {
		return nil, 0, 0, 0, err
	}

	adv, ok := face.GlyphAdvance('M')
	if !ok || adv <= 0 {
		fallback := fontSize * 0.6
		width = int(fallback)
	} else {
		width = adv.Round()
	}
	m := face.Metrics()
	height = (m.Ascent + m.Descent).Round()
	ascent = m.Ascent.Round()
	return face, width, height, ascent, nil
}

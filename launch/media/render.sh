#!/usr/bin/env bash
# Renders the Product Hunt launch posters from src/scenes.html with headless Chrome.
# Requires: Google Chrome. Usage: launch/media/render.sh
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SRC="file://$PWD/src/scenes.html"
GAL="$PWD/gallery"; OUT="$PWD/out"
mkdir -p "$GAL" "$OUT"

shot() { # scene width height output
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --virtual-time-budget=4000 --allow-file-access-from-files \
    --window-size="$2,$3" --screenshot="$4" "$SRC#$1" >/dev/null 2>&1
  # Chrome renders at 2x for crisp text; scale back to the exact target size.
  sips -z "$3" "$2" "$4" >/dev/null
  echo "  $(basename "$4")  ${2}x${3}"
}

echo "Posters (1270x760, Product Hunt gallery)"
for i in 01 02 03 04 05 06 07 08 09 10; do shot "p$i" 1270 760 "$GAL/$i.png"; done

echo "Bento posters (1270x760)"
for i in 1 2 3; do shot "b$i" 1270 760 "$GAL/bento-$i.png"; done

echo "Cross-platform posters: web, macOS and iOS (1270x760). Native shots come from native/capture.sh"
for i in 1 2 3 4 5; do shot "x$i" 1270 760 "$GAL/apps-$i.png"; done

echo "Web (2x PNG for the /demo page; converted to WebP by convert-web.mjs)"
WEB="$PWD/out/web"; mkdir -p "$WEB"
for i in 01 02 03 04 05 06 07 08 09 10; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --virtual-time-budget=4000 --allow-file-access-from-files \
    --window-size=1270,760 --screenshot="$WEB/$i@2x.png" "$SRC#p$i" >/dev/null 2>&1
done
echo "  out/web/NN@2x.png  2540x1520"

echo "Thumbnail / OG / teasers"
shot thumb 240 240 "$GAL/thumbnail.png"
shot og 1200 630 "$GAL/og-image.png"
cp "$GAL/og-image.png" "$ROOT/packages/portal/public/og-image.png"
shot teaser 1600 900 "$OUT/teaser-1600x900.png"
shot teaser 1080 1080 "$OUT/teaser-1080x1080.png"

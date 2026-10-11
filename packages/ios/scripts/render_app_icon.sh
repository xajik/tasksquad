#!/usr/bin/env bash
# Renders the iOS app icon from icon/tasksquad-icon-dark.svg as a full-bleed, opaque 1024x1024 PNG.
# iOS applies its own rounded mask, so the artwork must be square with no margin or rounded corners
# (rounded corners in the source leave a light frame around the icon on the home screen).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd ../.. && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT="TaskSquad/Assets.xcassets/AppIcon.appiconset/AppIcon.png"
TMP="$(mktemp -d)"
# Square corners, scaled to fill the page.
sed -e 's/ rx="112"//' -e 's/width="512" height="512" viewBox/width="1024" height="1024" viewBox/' \
  "$ROOT/icon/tasksquad-icon-dark.svg" > "$TMP/icon.svg"
printf '<!doctype html><style>html,body{margin:0;background:#0F1117}svg{display:block}</style>%s' "$(cat "$TMP/icon.svg")" > "$TMP/icon.html"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1024,1024 \
  --screenshot="$TMP/icon.png" "file://$TMP/icon.html" >/dev/null 2>&1
# App Store icons must not have an alpha channel.
sips -s format jpeg "$TMP/icon.png" --out "$TMP/icon.jpg" >/dev/null && sips -s format png "$TMP/icon.jpg" --out "$OUT" >/dev/null
echo "$OUT"

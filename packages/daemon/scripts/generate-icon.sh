#!/usr/bin/env bash
set -euo pipefail

# Generates dist/AppIcon.icns from the placeholder icon/tasksquad-icon-dark.png.
# Source is 512x512, so the 1024x1024 (@2x of 512) entry is upscaled — soft but
# acceptable for a placeholder. Swap the source PNG later; no script changes needed.

cd "$(dirname "$0")/.."

SRC="../../icon/tasksquad-icon-dark.png"
ICONSET="dist/AppIcon.iconset"

mkdir -p "$ICONSET"

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o dist/AppIcon.icns

echo "Wrote dist/AppIcon.icns"

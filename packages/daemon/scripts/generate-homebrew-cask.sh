#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${VERSION:-$(git describe --tags --abbrev=0)}"
VER="${VERSION#v}"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Expected stable version vX.Y.Z" >&2; exit 1; }
DMG="dist/TaskSquad-$VER.dmg"
[[ -s "$DMG" ]] || { echo "Missing $DMG" >&2; exit 1; }
SHA256=$(shasum -a 256 "$DMG" | awk '{print $1}')
mkdir -p dist/homebrew/Casks
sed -e "s/__VERSION__/$VER/g" -e "s/__SHA256__/$SHA256/g" \
  scripts/tasksquad.rb.template > dist/homebrew/Casks/tasksquad.rb
ruby -c dist/homebrew/Casks/tasksquad.rb

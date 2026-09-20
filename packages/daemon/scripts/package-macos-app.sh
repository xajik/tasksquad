#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${VERSION:-$(git describe --tags --abbrev=0)}"
VER="${VERSION#v}"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Expected stable version vX.Y.Z" >&2; exit 1; }
[[ -d dist/TaskSquad.app ]] || { echo "Run make app first" >&2; exit 1; }
[[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' dist/TaskSquad.app/Contents/Info.plist)" == "$VER" ]]

STAGING=$(mktemp -d "${TMPDIR:-/tmp}/tasksquad-dmg.XXXXXX")
trap 'rm -rf "$STAGING"' EXIT
ditto dist/TaskSquad.app "$STAGING/TaskSquad.app"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname TaskSquad -srcfolder "$STAGING" -ov -format UDZO "dist/TaskSquad-$VER.dmg"
(cd dist && shasum -a 256 "TaskSquad-$VER.dmg" > "TaskSquad-$VER.dmg.sha256")

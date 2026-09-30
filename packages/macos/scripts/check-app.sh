#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP=${APP_PATH:-dist/TaskSquad.app}
binary="$APP/Contents/MacOS/TaskSquad"
plutil -lint "$APP/Contents/Info.plist"
codesign --verify --deep --strict "$APP"
# Verify exactly the slices that were built (ARCHS empty = whatever build-app chose).
lipo "$binary" -verify_arch ${ARCHS:-$(lipo -archs "$binary")} || { echo "Unexpected architectures: $(lipo -archs "$binary")" >&2; exit 1; }
test -s "$APP/Contents/Resources/AppIcon.icns"
test -d "$APP/Contents/Resources/SwiftTerm_SwiftTerm.bundle"
# SwiftPM emits a flat resource bundle on some toolchains and a Contents/ one on others.
resources="$APP/Contents/Resources/TaskSquad_TaskSquad.bundle"
[[ -d "$resources/Contents/Resources" ]] && resources="$resources/Contents/Resources"
test -s "$resources/Resources/Icons/inbox.svg" || { echo "Missing icon resources in $resources" >&2; exit 1; }
test -s "$resources/Resources/Brand/tray.svg" || { echo "Missing brand resources in $resources" >&2; exit 1; }
"$binary" --version
"$binary" --check-config Tests/TaskSquadCoreTests/Fixtures/full.toml > /dev/null
if "$binary" --check-config Tests/TaskSquadCoreTests/Fixtures/invalid-type.toml 2>/dev/null; then
    echo "App accepted invalid configuration" >&2
    exit 1
fi
echo "App bundle, universal executable, signature, and configuration smoke checks passed."

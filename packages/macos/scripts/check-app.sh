#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP=${APP_PATH:-dist/TaskSquad.app}
binary="$APP/Contents/MacOS/TaskSquad"
plutil -lint "$APP/Contents/Info.plist"
codesign --verify --deep --strict "$APP"
# Verify exactly the slices that were built (ARCHS empty = whatever build-app chose).
lipo "$binary" -verify_arch ${ARCHS:-$(lipo -archs "$binary")}
test -s "$APP/Contents/Resources/AppIcon.icns"
test -d "$APP/Contents/Resources/SwiftTerm_SwiftTerm.bundle"
test -s "$APP/Contents/Resources/TaskSquad_TaskSquad.bundle/Contents/Resources/Resources/Icons/inbox.svg"
test -s "$APP/Contents/Resources/TaskSquad_TaskSquad.bundle/Contents/Resources/Resources/Brand/tray.svg"
"$binary" --version
"$binary" --check-config Tests/TaskSquadCoreTests/Fixtures/full.toml > /dev/null
if "$binary" --check-config Tests/TaskSquadCoreTests/Fixtures/invalid-type.toml 2>/dev/null; then
    echo "App accepted invalid configuration" >&2
    exit 1
fi
echo "App bundle, universal executable, signature, and configuration smoke checks passed."

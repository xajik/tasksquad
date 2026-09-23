#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP=${APP_PATH:-dist/TaskSquad.app}
binary="$APP/Contents/MacOS/TaskSquad"
plutil -lint "$APP/Contents/Info.plist"
codesign --verify --deep --strict "$APP"
lipo "$binary" -verify_arch arm64 x86_64
test -s "$APP/Contents/Resources/AppIcon.icns"
"$binary" --version
"$binary" --check-config Tests/TaskSquadCoreTests/Fixtures/full.toml > /dev/null
if "$binary" --check-config Tests/TaskSquadCoreTests/Fixtures/invalid-type.toml 2>/dev/null; then
    echo "App accepted invalid configuration" >&2
    exit 1
fi
echo "App bundle, universal executable, signature, and configuration smoke checks passed."

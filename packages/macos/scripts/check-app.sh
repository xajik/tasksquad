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
bundle_resources() { local path="$APP/Contents/Resources/$1"; [[ -d "$path/Contents/Resources" ]] && path="$path/Contents/Resources"; echo "$path"; }
resources=$(bundle_resources TaskSquad_TaskSquad.bundle)
test -s "$resources/Resources/Brand/tray.svg" || { echo "Missing tray resources in $resources" >&2; exit 1; }
design=$(bundle_resources TaskSquadPortal_TaskSquadDesign.bundle)
test -s "$design/Vectors/Icons/inbox.svg" || { echo "Missing icon resources in $design" >&2; exit 1; }
test -s "$design/Vectors/Brand/logo.svg" || { echo "Missing brand resources in $design" >&2; exit 1; }
"$binary" --version
cli="$APP/Contents/MacOS/tsq"
lipo "$cli" -verify_arch ${ARCHS:-$(lipo -archs "$binary")}
! otool -L "$cli" | grep -qiE 'AppKit|SwiftUI' || { echo "tsq must not link UI frameworks" >&2; exit 1; }
"$cli" --version
"$cli" sessions > /dev/null
"$binary" --check-config ../tsq-core/Tests/Shared/CoreTests/Fixtures/full.toml > /dev/null
if "$binary" --check-config ../tsq-core/Tests/Shared/CoreTests/Fixtures/invalid-type.toml 2>/dev/null; then
    echo "App accepted invalid configuration" >&2
    exit 1
fi
echo "App bundle, universal executable, signature, and configuration smoke checks passed."

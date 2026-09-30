#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=${VERSION:-0.1.0-dev}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]] || { echo "Expected X.Y.Z[-suffix]" >&2; exit 1; }
APP="dist/TaskSquad.app"
# Universal by default for releases. SwiftTerm's x86_64 build-info plugin must
# execute during the build, so without Rosetta fall back to the native slice.
if [[ -z "${ARCHS:-}" ]]; then
    ARCHS="arm64 x86_64"
    if [[ "$(uname -m)" == "arm64" ]] && ! arch -x86_64 /usr/bin/true 2>/dev/null; then
        echo "warning: Rosetta is unavailable; building arm64 only (set ARCHS to override)" >&2
        ARCHS="arm64"
    fi
fi
first=${ARCHS%% *}
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
for arch in $ARCHS; do
    swift build -c release --arch "$arch" --scratch-path ".build/$arch"
    path=$(swift build -c release --arch "$arch" --scratch-path ".build/$arch" --show-bin-path)
    cp "$path/TaskSquad" "dist/TaskSquad-$arch"
    # SwiftTerm's Metal shaders are architecture-independent SwiftPM resources.
    # Its packaged-app lookup includes Contents/Resources.
    if [[ "$arch" == "$first" ]]; then
        ditto "$path/SwiftTerm_SwiftTerm.bundle" "$APP/Contents/Resources/SwiftTerm_SwiftTerm.bundle"
        ditto "$path/TaskSquad_TaskSquad.bundle" "$APP/Contents/Resources/TaskSquad_TaskSquad.bundle"
    fi
done
slices=(); for arch in $ARCHS; do slices+=("dist/TaskSquad-$arch"); done
lipo -create "${slices[@]}" -output "$APP/Contents/MacOS/TaskSquad"
VERSION="$VERSION" /usr/bin/python3 - "$APP/Contents/Info.plist" <<'PY'
import os, plistlib, sys
version = os.environ['VERSION']
with open(sys.argv[1], 'wb') as output:
    plistlib.dump({
        'CFBundleName': 'TaskSquad',
        'CFBundleDisplayName': 'TaskSquad',
        'CFBundleExecutable': 'TaskSquad',
        'CFBundleIdentifier': 'ai.tasksquad.native',
        'CFBundlePackageType': 'APPL',
        'CFBundleInfoDictionaryVersion': '6.0',
        'CFBundleShortVersionString': version.split('-')[0],
        'CFBundleVersion': version.split('-')[0],
        'TSQVersion': version,
        'CFBundleIconFile': 'AppIcon',
        'LSMinimumSystemVersion': '13.0',
        'NSHighResolutionCapable': True,
        'NSPrincipalClass': 'NSApplication',
    }, output)
PY
swift scripts/Icon.swift dist/AppIcon.iconset ../../icon/tasksquad-favicon.svg
iconutil -c icns dist/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$APP"
echo "Built $APP ($VERSION, ${ARCHS// / + })"

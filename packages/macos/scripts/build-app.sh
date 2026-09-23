#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=${VERSION:-0.1.0-dev}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]] || { echo "Expected X.Y.Z[-suffix]" >&2; exit 1; }
APP="dist/TaskSquad.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
for arch in arm64 x86_64; do
    swift build -c release --arch "$arch" --scratch-path ".build/$arch"
    path=$(swift build -c release --arch "$arch" --scratch-path ".build/$arch" --show-bin-path)
    cp "$path/TaskSquad" "dist/TaskSquad-$arch"
done
lipo -create dist/TaskSquad-arm64 dist/TaskSquad-x86_64 -output "$APP/Contents/MacOS/TaskSquad"
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
echo "Built $APP ($VERSION, arm64 + x86_64)"

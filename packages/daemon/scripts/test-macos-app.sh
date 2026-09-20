#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${VERSION:-$(git describe --tags --abbrev=0)}"
VER="${VERSION#v}"
APP="dist/TaskSquad.app"

check_app() {
  local app="$1" plist="$1/Contents/Info.plist" binary="$1/Contents/MacOS/TaskSquad"
  plutil -lint "$plist"
  [[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$plist")" == ai.tasksquad.tsq ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$plist")" == "$VER" ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print LSUIElement' "$plist")" == true ]]
  [[ -s "$app/Contents/Resources/AppIcon.icns" ]]
  lipo "$binary" -verify_arch arm64 x86_64
  # Verify the GUI dependency is linked (the CLI-only build also supports --version).
  otool -L "$binary" | grep -q '/AppKit.framework/'
  [[ "$("$binary" --version)" == "tsq $VERSION" ]]
  [[ "$("$app/Contents/MacOS/tsq" --version)" == "tsq $VERSION" ]]
}

check_app "$APP"
DMG="dist/TaskSquad-$VER.dmg"
if [[ -f "$DMG" ]]; then
  (cd dist && shasum -a 256 -c "TaskSquad-$VER.dmg.sha256")
  TEMP=$(mktemp -d "${TMPDIR:-/tmp}/tasksquad-install.XXXXXX")
  cleanup() {
    hdiutil detach "$TEMP/mount" >/dev/null 2>&1 || true
    rm -rf "$TEMP"
  }
  trap cleanup EXIT
  hdiutil attach "$DMG" -readonly -nobrowse -mountpoint "$TEMP/mount" >/dev/null
  [[ "$(readlink "$TEMP/mount/Applications")" == /Applications ]]
  # Simulate dragging to Applications without replacing the user's installation.
  ditto "$TEMP/mount/TaskSquad.app" "$TEMP/Applications/TaskSquad.app"
  check_app "$TEMP/Applications/TaskSquad.app"
fi
echo "App structure, universal architectures, GUI linkage, bundled CLI, and installation checks passed."

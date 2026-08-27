#!/usr/bin/env bash
set -euo pipefail

# Assembles dist/TaskSquad.app around a cgo-enabled universal (arm64+amd64) tsq
# binary. Does NOT sign or notarize — that happens in CI where signing secrets
# are available. Run `scripts/generate-icon.sh` first (or ensure dist/AppIcon.icns
# already exists) before running this.
#
# Usage: VERSION=v1.2.3 scripts/build-macos-app.sh
#        (VERSION defaults to `git describe --tags --abbrev=0`)

cd "$(dirname "$0")/.."

VERSION="${VERSION:-$(git describe --tags --abbrev=0 2>/dev/null || echo dev)}"
VER="${VERSION#v}"

if [[ ! -f dist/AppIcon.icns ]]; then
  echo "dist/AppIcon.icns not found — run scripts/generate-icon.sh first" >&2
  exit 1
fi

mkdir -p dist

echo "Building tsq for darwin/arm64 (cgo enabled)..."
CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 MACOSX_DEPLOYMENT_TARGET=11.0 \
  go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o dist/tsq-darwin-arm64 .

echo "Building tsq for darwin/amd64 (cgo enabled)..."
CGO_ENABLED=1 GOOS=darwin GOARCH=amd64 MACOSX_DEPLOYMENT_TARGET=11.0 \
  go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o dist/tsq-darwin-amd64 .

echo "Creating universal binary..."
lipo -create -output dist/TaskSquad-bin dist/tsq-darwin-arm64 dist/tsq-darwin-amd64
lipo -info dist/TaskSquad-bin

echo "Assembling TaskSquad.app..."
rm -rf dist/TaskSquad.app
mkdir -p dist/TaskSquad.app/Contents/MacOS dist/TaskSquad.app/Contents/Resources

cp dist/TaskSquad-bin dist/TaskSquad.app/Contents/MacOS/TaskSquad
chmod +x dist/TaskSquad.app/Contents/MacOS/TaskSquad

cp dist/AppIcon.icns dist/TaskSquad.app/Contents/Resources/AppIcon.icns

sed "s/__VERSION__/$VER/g" scripts/Info.plist.template > dist/TaskSquad.app/Contents/Info.plist

echo "Built dist/TaskSquad.app (unsigned, version $VER)"

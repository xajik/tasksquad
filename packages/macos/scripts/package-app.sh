#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${VERSION:-0.1.0-dev}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]] || exit 1
staging=$(mktemp -d "${TMPDIR:-/tmp}/tasksquad-dmg.XXXXXX")
trap 'rm -rf "$staging"' EXIT
ditto dist/TaskSquad.app "$staging/TaskSquad Native.app"
ln -s /Applications "$staging/Applications"
dmg="dist/TaskSquad-Native-$VERSION.dmg"
hdiutil create -volname 'TaskSquad Native' -srcfolder "$staging" -ov -format UDZO "$dmg"
(cd dist && shasum -a 256 "${dmg#dist/}" > "${dmg#dist/}.sha256")
echo "$dmg"

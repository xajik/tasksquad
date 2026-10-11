#!/bin/bash
# Standalone `tsq` (CLI + headless daemon) for users who don't want the app:
# dist/tsq_Darwin_universal.tar.gz with tsq and its resource bundle (screenshot font).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${VERSION:-0.1.0-dev}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]] || { echo "Expected X.Y.Z[-suffix]" >&2; exit 1; }
if [[ -z "${ARCHS:-}" ]]; then
    ARCHS="arm64 x86_64"
    if [[ "$(uname -m)" == "arm64" ]] && ! arch -x86_64 /usr/bin/true 2>/dev/null; then ARCHS="arm64"; fi
fi
build_file=Sources/TaskSquadCLI/Build.swift
cp "$build_file" "$build_file.orig"
trap 'mv "$build_file.orig" "$build_file"' EXIT
sed -i '' "s/public static let version = \".*\"/public static let version = \"$VERSION\"/" "$build_file"
out=dist/cli
rm -rf "$out"; mkdir -p "$out"
slices=()
for arch in $ARCHS; do
    swift build -c release --arch "$arch" --scratch-path ".build/cli-$arch" --product tsq
    path=$(swift build -c release --arch "$arch" --scratch-path ".build/cli-$arch" --show-bin-path)
    cp "$path/tsq" "dist/tsq-cli-$arch"; slices+=("dist/tsq-cli-$arch")
    [[ -d "$out/TaskSquad_TaskSquadCore.bundle" ]] || ditto "$path/TaskSquad_TaskSquadCore.bundle" "$out/TaskSquad_TaskSquadCore.bundle"
done
lipo -create "${slices[@]}" -output "$out/tsq"
codesign --force --sign "${SIGNING_IDENTITY:--}" ${SIGNING_IDENTITY:+--options runtime --timestamp} "$out/tsq"
"$out/tsq" --version | grep -qx "tsq $VERSION"
tarball="dist/tsq_Darwin_universal.tar.gz"
tar -czf "$tarball" -C "$out" tsq TaskSquad_TaskSquadCore.bundle
(cd dist && shasum -a 256 "$(basename "$tarball")" > "$(basename "$tarball").sha256")
echo "$tarball (tsq $VERSION, ${ARCHS// / + })"

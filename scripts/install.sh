#!/bin/sh
set -e

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
VERSION=$(curl -fsSL https://api.github.com/repos/tasksquad/tasksquad/releases/latest \
  | grep '"tag_name"' | cut -d'"' -f4)

case "${OS}-${ARCH}" in
  darwin-arm64)  BINARY="tsq-darwin-arm64" ;;
  darwin-x86_64) BINARY="tsq-darwin-amd64" ;;
  linux-x86_64)  BINARY="tsq-linux-amd64"  ;;
  *)
    echo "Unsupported platform: ${OS}-${ARCH}"
    exit 1
    ;;
esac

URL="https://github.com/tasksquad/tasksquad/releases/download/${VERSION}/${BINARY}"
DEST="/usr/local/bin/tsq"

echo "Downloading TaskSquad ${VERSION}..."
curl -fsSL "${URL}" -o "${DEST}"
chmod +x "${DEST}"

echo "Installed: tsq ${VERSION}"
echo "Run: tsq init"

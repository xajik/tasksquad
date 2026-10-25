#!/bin/sh
set -e

# TaskSquad Installation Script
# https://tasksquad.ai

REPO="xajik/tasksquad"
BINARY_NAME="tsq"

# Detect OS
OS_RAW=$(uname -s)
ARCH_RAW=$(uname -m)

case "$OS_RAW" in
    Darwin) OS="Darwin" ;;
    Linux)  OS="Linux" ;;
    MSYS*|MINGW*|CYGWIN*) OS="Windows" ;;
    *) echo "Unsupported OS: $OS_RAW"; exit 1 ;;
esac

case "$ARCH_RAW" in
    x86_64|amd64) ARCH="x86_64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH_RAW"; exit 1 ;;
esac

# Get latest release tag
VERSION=$(curl --proto '=https' --proto-redir '=https' -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')

if [ -z "$VERSION" ]; then
    echo "Error: Could not find latest version for $REPO"
    exit 1
fi

EXT="tar.gz"
if [ "$OS" = "Windows" ]; then
    EXT="zip"
fi

FILENAME="${BINARY_NAME}_${OS}_${ARCH}.${EXT}"
URL="https://github.com/$REPO/releases/download/$VERSION/$FILENAME"

echo "Downloading TaskSquad $VERSION for ${OS}-${ARCH}..."
# Create temporary directory
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# Download
curl --proto '=https' --proto-redir '=https' -fsSL "$URL" -o "$TMP_DIR/$FILENAME"
curl --proto '=https' --proto-redir '=https' -fsSL \
    "https://github.com/$REPO/releases/download/$VERSION/checksums.txt" -o "$TMP_DIR/checksums.txt"

# Verify the archive before extracting or installing anything.
EXPECTED=$(awk -v filename="$FILENAME" '$2 == filename { print $1 }' "$TMP_DIR/checksums.txt")
if [ "${#EXPECTED}" -ne 64 ] || printf '%s' "$EXPECTED" | LC_ALL=C grep -q '[^0-9a-fA-F]'; then
    echo "Error: missing or invalid checksum for $FILENAME" >&2
    exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
    (cd "$TMP_DIR" && printf '%s  %s\n' "$EXPECTED" "$FILENAME" | sha256sum -c -)
elif command -v shasum >/dev/null 2>&1; then
    (cd "$TMP_DIR" && printf '%s  %s\n' "$EXPECTED" "$FILENAME" | shasum -a 256 -c -)
else
    echo "Error: sha256sum or shasum is required to verify the download" >&2
    exit 1
fi

# Extract
if [ "$EXT" = "tar.gz" ]; then
    tar -xzf "$TMP_DIR/$FILENAME" -C "$TMP_DIR"
else
    # Check if unzip is available for Windows/Git Bash
    if command -v unzip >/dev/null 2>&1; then
        unzip -q "$TMP_DIR/$FILENAME" -d "$TMP_DIR"
    else
        echo "Error: unzip command not found. Please extract $TMP_DIR/$FILENAME manually."
        exit 1
    fi
fi

# Install
if [ "$OS" = "Windows" ]; then
    DEST_DIR="$HOME/bin"
    mkdir -p "$DEST_DIR"
    mv "$TMP_DIR/${BINARY_NAME}.exe" "$DEST_DIR/"
    echo "TaskSquad daemon installed to $DEST_DIR/${BINARY_NAME}.exe"
    echo "Ensure $DEST_DIR is in your PATH."
else
    # Linux/Darwin
    echo "Installing to /usr/local/bin/${BINARY_NAME} (may require sudo)..."
    if [ -w "/usr/local/bin" ]; then
        mv "$TMP_DIR/${BINARY_NAME}" /usr/local/bin/
    else
        sudo mv "$TMP_DIR/${BINARY_NAME}" /usr/local/bin/
    fi
    echo "TaskSquad daemon installed to /usr/local/bin/${BINARY_NAME}"
fi

echo "Installation complete. Run '${BINARY_NAME} init' to get started."

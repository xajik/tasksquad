#!/bin/bash

set -e

SKILL_NAME="task_squad"
SKILL_SOURCE="$(cd "$(dirname "$0")/task_squad" && pwd)"
SKILL_URL="https://raw.githubusercontent.com/tasksquadai/tasksquad-doc/main/skills/task_squad/SKILL.md"

install_skill() {
    local dest="$1"
    mkdir -p "$dest"
    rm -rf "$dest/$SKILL_NAME" 2>/dev/null || true
    cp -r "$SKILL_SOURCE" "$dest/"
    echo "Installed to $dest/$SKILL_NAME"/simpo
}

uninstall_skill() {
    local dest="$1"
    if [ -d "$dest/$SKILL_NAME" ]; then
        rm -rf "$dest/$SKILL_NAME"
        echo "Uninstalled from $dest"
    fi
}

remote_install() {
    TEMP_DIR=$(mktemp -d)
    curl -sSL "$SKILL_URL" -o "$TEMP_DIR/SKILL.md"
    mkdir -p "$TEMP_DIR/$SKILL_NAME"
    mv "$TEMP_DIR/SKILL.md" "$TEMP_DIR/$SKILL_NAME/"
    echo "Downloaded to $TEMP_DIR/$SKILL_NAME"
}

install_all() {
    local dirs=(
        "$HOME/.claude/skills"
        "$HOME/.agents/skills"
        "$HOME/.codex/skills"
    )

    for dir in "${dirs[@]}"; do
        install_skill "$dir"
    done
}

uninstall_all() {
    local dirs=(
        "$HOME/.claude/skills"
        "$HOME/.agents/skills"
        "$HOME/.codex/skills"
    )

    for dir in "${dirs[@]}"; do
        uninstall_skill "$dir"
    done
}

case "${1:-install}" in
    install)
        install_all
        ;;
    uninstall)
        uninstall_all
        ;;
    remote)
        remote_install
        ;;
    *)
        echo "Usage: $0 {install|uninstall|remote}"
        exit 1
        ;;
esac

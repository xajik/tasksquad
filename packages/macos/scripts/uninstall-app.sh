#!/bin/bash
# Removes the local TaskSquad Native install: quits the app and its daemon,
# removes the login item, the app bundle and the `tsq` link that points into it.
# Config, tasks, logs and Keychain sign-ins in ~/.tasksquad are kept (the Go
# daemon shares them) unless PURGE=1.
set -uo pipefail
APP_DIR=${APP_DIR:-"$HOME/Applications"}
APP="$APP_DIR/TaskSquad Native.app"
LABEL=ai.tasksquad.tsq
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CLI_LINK=${CLI_LINK:-"$HOME/.local/bin/tsq"}

# Quit the app gracefully, then stop anything still running from the bundle.
if pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1; then
    osascript -e 'tell application id "ai.tasksquad.native" to quit' >/dev/null 2>&1
    for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1 || break; sleep 1; done
    pkill -f "$APP/Contents/MacOS/" 2>/dev/null
fi

# Login item (same label and plist as the Go daemon's autostart).
if [ -e "$PLIST" ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
    rm -f "$PLIST" && echo "Removed $PLIST"
fi

# The CLI link, only if it points into an app bundle; a Go/Homebrew tsq is left alone.
if [ -L "$CLI_LINK" ] && readlink "$CLI_LINK" | grep -q 'TaskSquad Native.app'; then
    rm -f "$CLI_LINK" && echo "Removed $CLI_LINK"
elif [ -e "$CLI_LINK" ]; then
    echo "Kept $CLI_LINK (not a link to the app)"
fi

if [ -d "$APP" ]; then rm -rf "$APP" && echo "Removed $APP"; else echo "No app at $APP"; fi

defaults delete ai.tasksquad.native >/dev/null 2>&1
rm -rf "$HOME/Library/Caches/ai.tasksquad.native" "$HOME/Library/Saved Application State/ai.tasksquad.native.savedState"

if [ "${PURGE:-0}" = 1 ]; then
    rm -rf "$HOME/.tasksquad" && echo "Removed $HOME/.tasksquad"
    for account in $(security dump-keychain 2>/dev/null | grep -o '"svce"<blob>="tasksquad-[^"]*"' | sed 's/.*="//;s/"//' | sort -u); do
        while security delete-generic-password -s "$account" >/dev/null 2>&1; do :; done
    done
    echo "Removed saved sign-ins from the login Keychain"
else
    echo "Kept ~/.tasksquad and Keychain sign-ins (make uninstall PURGE=1 removes them too)"
fi

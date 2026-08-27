#!/usr/bin/env bash
set -euo pipefail

# Signs, notarizes, staples, and packages dist/TaskSquad.app using a
# Developer ID certificate that Xcode has already installed in your login
# keychain, plus a notarytool credential profile stored via
# `xcrun notarytool store-credentials`. Mirrors the CI job in
# .github/workflows/daemon.yml but reads credentials from the local keychain
# instead of GitHub Actions secrets.
#
# One-time setup (see README note in this directory or ask for the walkthrough):
#   1. Xcode -> Settings -> Accounts -> add your Apple ID -> Manage Certificates
#      -> "+" -> Developer ID Application. Xcode installs the cert+key into
#      your login keychain automatically.
#   2. security find-identity -v -p codesigning
#      -> copy the "Developer ID Application: NAME (TEAMID)" string.
#   3. xcrun notarytool store-credentials "tasksquad-notary" \
#        --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
#      (App-specific password from https://appleid.apple.com -> Sign-In and Security.)
#
# Then set in packages/daemon/.env (gitignored):
#   SIGNING_IDENTITY=Developer ID Application: NAME (TEAMID)
#   NOTARY_PROFILE=tasksquad-notary
#
# Usage: make app-signed   (builds unsigned app first, then runs this)

cd "$(dirname "$0")/.."

: "${SIGNING_IDENTITY:?Set SIGNING_IDENTITY in packages/daemon/.env — see script header for how to find it}"
: "${NOTARY_PROFILE:?Set NOTARY_PROFILE in packages/daemon/.env — see script header for the one-time store-credentials step}"

if [[ ! -d dist/TaskSquad.app ]]; then
  echo "dist/TaskSquad.app not found — run 'make app' first" >&2
  exit 1
fi

VERSION="${VERSION:-$(git describe --tags --abbrev=0 2>/dev/null || echo dev)}"
VER="${VERSION#v}"

echo "Codesigning with identity: $SIGNING_IDENTITY"
codesign --force --deep --options runtime --timestamp \
  --entitlements scripts/entitlements.plist \
  --sign "$SIGNING_IDENTITY" \
  dist/TaskSquad.app
codesign --verify --deep --strict --verbose=2 dist/TaskSquad.app

echo "Submitting for notarization (profile: $NOTARY_PROFILE)..."
ditto -c -k --keepParent dist/TaskSquad.app dist/TaskSquad.zip
xcrun notarytool submit dist/TaskSquad.zip --keychain-profile "$NOTARY_PROFILE" --wait
rm -f dist/TaskSquad.zip

echo "Stapling notarization ticket..."
xcrun stapler staple dist/TaskSquad.app

echo "Verifying Gatekeeper acceptance..."
spctl --assess --type execute -vv dist/TaskSquad.app

echo "Building DMG..."
rm -rf dist/dmg-root
mkdir dist/dmg-root
cp -R dist/TaskSquad.app dist/dmg-root/
ln -s /Applications dist/dmg-root/Applications
hdiutil create -volname TaskSquad -srcfolder dist/dmg-root -ov -format UDZO \
  "dist/TaskSquad-$VER.dmg"
rm -rf dist/dmg-root

echo "Done: dist/TaskSquad.app (signed, notarized, stapled) and dist/TaskSquad-$VER.dmg"

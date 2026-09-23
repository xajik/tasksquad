#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SIGNING_IDENTITY:?Set SIGNING_IDENTITY to your Developer ID Application identity}"
: "${NOTARY_PROFILE:?Set NOTARY_PROFILE to an existing notarytool Keychain profile}"
codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" dist/TaskSquad.app
codesign --verify --deep --strict --verbose=2 dist/TaskSquad.app
ditto -c -k --keepParent dist/TaskSquad.app dist/TaskSquad-notarization.zip
notary_args=(--keychain-profile "$NOTARY_PROFILE")
if [[ -n "${NOTARY_KEYCHAIN:-}" ]]; then notary_args+=(--keychain "$NOTARY_KEYCHAIN"); fi
xcrun notarytool submit dist/TaskSquad-notarization.zip "${notary_args[@]}" --wait --output-format json > dist/notarization.json
/usr/bin/python3 - <<'PY'
import json
with open('dist/notarization.json') as source:
    result = json.load(source)
if result.get('status') != 'Accepted':
    raise SystemExit('Notarization was not accepted; inspect dist/notarization.json')
PY
xcrun stapler staple dist/TaskSquad.app
xcrun stapler validate dist/TaskSquad.app
spctl --assess --type execute -vv dist/TaskSquad.app

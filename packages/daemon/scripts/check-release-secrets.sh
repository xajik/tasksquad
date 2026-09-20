#!/usr/bin/env bash
set -euo pipefail
missing=0
for name in MACOS_CERTIFICATE_P12_BASE64 MACOS_CERTIFICATE_PASSWORD MACOS_SIGNING_IDENTITY \
  APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_API_KEY_P8 TAP_GITHUB_TOKEN; do
  if [[ -z "${!name:-}" ]]; then
    echo "::error::Missing release secret: $name (see packages/daemon/RELEASING.md)"
    missing=1
  fi
done
exit "$missing"

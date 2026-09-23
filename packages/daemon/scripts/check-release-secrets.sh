#!/usr/bin/env bash
set -euo pipefail
# Informational only: the release workflow decides on its own whether to sign
# (see the "Validate release tag and credentials" step in daemon.yml) and
# falls back to an ad-hoc-signed, unnotarized app when these are absent
# rather than failing the release. This just surfaces what's missing.
missing=0
for name in MACOS_CERTIFICATE_P12_BASE64 MACOS_CERTIFICATE_PASSWORD MACOS_SIGNING_IDENTITY \
  APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_API_KEY_P8 TAP_GITHUB_TOKEN; do
  if [[ -z "${!name:-}" ]]; then
    echo "::warning::Missing release secret: $name (see packages/daemon/RELEASING.md)"
    missing=1
  fi
done
if [[ "$missing" = 1 ]]; then
  echo "::warning::Some release secrets are missing — the app will ship ad-hoc signed (unsigned, unnotarized) instead of failing the release."
fi
exit 0

#!/usr/bin/env bash
# Captures launch screenshots of the real iOS and macOS apps into launch/media/out/native/.
#
# Real data: start readonly_proxy.py first (see its docstring), then run this script. Both apps read
# the project named $PROMO_PROJECT (default orbit-web) through http://127.0.0.1:18744, GET only.
# Without the proxy, only the macOS screens are rendered, from sample-workspace.json (sample_workspace.py).
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"; ROOT="$(cd ../../.. && pwd)"; OUT="$ROOT/launch/media/out/native"
API="http://127.0.0.1:${TSQ_PROXY_PORT:-18744}"
export PROMO_PROJECT="${PROMO_PROJECT:-orbit-web}"
mkdir -p "$OUT"

if curl -fsS -o /dev/null "$API/me"; then
  echo "Using the read-only proxy at $API (project: $PROMO_PROJECT)"
  MAC_SOURCE=(TSQ_PROMO_API="$API")
  # The booted simulator, so the status bar override (9:41, full battery) applies to the shots.
  UDID="$(xcrun simctl list devices booted -j | python3 -c "import json,sys;print(next(d['udid'] for v in json.load(sys.stdin)['devices'].values() for d in v))")"
  xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4
  SIM="id=$UDID"
  RESULT="$ROOT/packages/ios/.build/promo.xcresult"; rm -rf "$RESULT"
  (cd "$ROOT/packages/ios" && make generate >/dev/null && \
    TEST_RUNNER_PROMO_API="$API" TEST_RUNNER_PROMO_PROJECT="$PROMO_PROJECT" xcodebuild -project TaskSquad.xcodeproj -scheme TaskSquad \
      -destination "$SIM" -derivedDataPath .build/DerivedData -skipPackagePluginValidation \
      CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual \
      -only-testing:TaskSquadUITests/PromoScreenshotTests -resultBundlePath "$RESULT" test | tail -3)
  TMP="$(mktemp -d)"
  xcrun xcresulttool export attachments --path "$RESULT" --output-path "$TMP" >/dev/null
  python3 - "$TMP" "$OUT" <<'EOF'
import json, shutil, sys, pathlib
src, out = map(pathlib.Path, sys.argv[1:])
for test in json.loads((src / 'manifest.json').read_text()):
    for a in test['attachments']:
        name = a['suggestedHumanReadableName'].split('_0_')[0].removesuffix('.png')
        shutil.copy(src / a['exportedFileName'], out / f'{name}.png'); print('  ' + name)
EOF
else
  echo "No proxy at $API; rendering macOS from the sample workspace only"
  python3 "$HERE/sample_workspace.py" >/dev/null
  MAC_SOURCE=(TSQ_PROMO_SEED="$HERE/sample-workspace.json")
fi

(cd "$ROOT/packages/macos" && env "${MAC_SOURCE[@]}" TSQ_UI_ARTIFACTS="$OUT" swift test --filter PromoRenderTests 2>&1 | grep -E "error|Executed 1 test" | head -3)
ls "$OUT"

#!/usr/bin/env bash
# Captures launch screenshots of the real iOS and macOS apps into launch/media/out/native/.
#
# Real data: start readonly_proxy.py first (see its docstring), then run this script. Both apps read
# the project named $PROMO_PROJECT (default orbit-web) through http://127.0.0.1:18744, GET only.
# Without the proxy, both apps read sample-workspace.json (sample_workspace.py): iOS through the contract
# fixture on :18743 (`workspace_fixture.py --seed`), macOS through an in-process transport.
# Needs a booted iPhone simulator and packages/ios/.build/fixture-env (`make -C packages/ios fixture` creates it).
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"; ROOT="$(cd ../../.. && pwd)"; OUT="$ROOT/launch/media/out/native"
API="http://127.0.0.1:${TSQ_PROXY_PORT:-18744}"
export PROMO_PROJECT="${PROMO_PROJECT:-orbit-web}"
mkdir -p "$OUT"

ios_capture() { # $1: API base the debug app reads. The promo test only navigates and reads.
  local udid result tmp
  # The booted simulator, so the status bar override (9:41, full battery) applies to the shots.
  udid="$(xcrun simctl list devices booted -j | python3 -c "import json,sys;print(next(d['udid'] for v in json.load(sys.stdin)['devices'].values() for d in v))")"
  xcrun simctl status_bar "$udid" override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4
  result="$ROOT/packages/ios/.build/promo.xcresult"; rm -rf "$result"
  (cd "$ROOT/packages/ios" && make generate >/dev/null && \
    TEST_RUNNER_PROMO_API="$1" TEST_RUNNER_PROMO_PROJECT="$PROMO_PROJECT" xcodebuild -project TaskSquad.xcodeproj -scheme TaskSquad \
      -destination "id=$udid" -derivedDataPath .build/DerivedData -skipPackagePluginValidation \
      CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual \
      -only-testing:TaskSquadUITests/PromoScreenshotTests -resultBundlePath "$result" test | tail -2) || true
  tmp="$(mktemp -d)"
  xcrun xcresulttool export attachments --path "$result" --output-path "$tmp" >/dev/null
  python3 "$HERE/export_attachments.py" "$tmp" "$OUT"
}

if curl -fsS -o /dev/null "$API/me" 2>/dev/null; then
  echo "Real data: read-only proxy at $API (project: $PROMO_PROJECT)"
  ios_capture "$API"
  MAC_SOURCE=(TSQ_PROMO_API="$API")
else
  echo "No proxy at $API: capturing both apps from the sample workspace"
  python3 "$HERE/sample_workspace.py" >/dev/null
  "$ROOT/packages/ios/.build/fixture-env/bin/python" "$ROOT/packages/ios/scripts/workspace_fixture.py" \
    --seed "$HERE/sample-workspace.json" > "$OUT/../fixture.log" 2>&1 &
  FIXTURE_PID=$!; trap 'kill $FIXTURE_PID 2>/dev/null' EXIT
  for _ in $(seq 50); do curl -fsS -o /dev/null http://127.0.0.1:18743/__test/state 2>/dev/null && break; sleep 0.2; done
  ios_capture "http://127.0.0.1:18743"
  MAC_SOURCE=(TSQ_PROMO_SEED="$HERE/sample-workspace.json")
fi

(cd "$ROOT/packages/macos" && env "${MAC_SOURCE[@]}" TSQ_UI_ARTIFACTS="$OUT" swift test --filter PromoRenderTests 2>&1 | grep -E "error|Executed 1 test" | head -3)
ls "$OUT"

# Tracked, compressed copies the posters use (src/scenes.html reads ../shots/native/).
mkdir -p ../shots/native
for f in "$OUT"/*-light.png "$OUT"/*-dark.png; do
  [ -e "$f" ] && sips -s format jpeg -s formatOptions 82 "$f" --out "../shots/native/$(basename "${f%.png}").jpg" >/dev/null
done
echo "Copied to launch/media/shots/native/"

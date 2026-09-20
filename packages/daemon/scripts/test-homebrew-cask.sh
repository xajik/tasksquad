#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Homebrew rejects standalone cask files: validate in a disposable local tap.
TAP_PARENT="$(brew --repository)/Library/Taps/tasksquad-validation"
mkdir -p "$TAP_PARENT"
TAP="$TAP_PARENT/homebrew-check-$$"
mkdir "$TAP"
cleanup() {
  rm -rf "$TAP"
  rmdir "$TAP_PARENT" 2>/dev/null || true
}
trap cleanup EXIT
mkdir "$TAP/Casks"
cp dist/homebrew/Casks/tasksquad.rb "$TAP/Casks/tasksquad.rb"
git -C "$TAP" init -q
# Newer Homebrew versions require trust for local taps. Keep that test-only
# trust record inside the disposable directory, separate from user settings.
export XDG_CONFIG_HOME="$TAP/test-config"
if brew command trust >/dev/null 2>&1; then
  brew trust "tasksquad-validation/check-$$"
fi
HOMEBREW_NO_AUTO_UPDATE=1 brew info --cask --json=v2 "$TAP/Casks/tasksquad.rb" > dist/homebrew/cask-info.json
python3 - <<'PY'
import hashlib, json
from pathlib import Path
cask = json.loads(Path('dist/homebrew/cask-info.json').read_text())['casks'][0]
version = cask['version']
dmg = Path(f'dist/TaskSquad-{version}.dmg')
assert cask['sha256'] == hashlib.sha256(dmg.read_bytes()).hexdigest()
assert cask['url'] == f'https://github.com/xajik/tasksquad/releases/download/v{version}/TaskSquad-{version}.dmg'
assert any(a.get('app') == ['TaskSquad.app'] for a in cask['artifacts'])
assert not any('binary' in a for a in cask['artifacts']), 'App cask must not replace the CLI formula'
assert 'tmux' in cask['depends_on']['formula']
print('Homebrew loaded the app cask; URL, checksum, dependency, and CLI coexistence checks passed.')
PY

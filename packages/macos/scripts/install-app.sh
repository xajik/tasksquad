#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export APP_DIR=${APP_DIR:-"$HOME/Applications"}
/usr/bin/python3 - <<'PY'
import os, pathlib, shutil, subprocess, tempfile
parent = pathlib.Path(os.environ['APP_DIR']).expanduser()
parent.mkdir(parents=True, exist_ok=True)
destination = parent / 'TaskSquad Native.app'
executable = str(destination / 'Contents/MacOS/TaskSquad')
running = subprocess.check_output(['/bin/ps', '-axo', 'comm='], text=True).splitlines()
if executable in (line.strip() for line in running):
    raise SystemExit('Quit TaskSquad Native before updating its app bundle.')
with tempfile.TemporaryDirectory(prefix='.tasksquad-install-', dir=parent) as temporary:
    staged = pathlib.Path(temporary) / destination.name
    backup = pathlib.Path(temporary) / 'previous.app'
    subprocess.run(['/usr/bin/ditto', 'dist/TaskSquad.app', str(staged)], check=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(staged)], check=True)
    if destination.exists():
        destination.rename(backup)
    try:
        staged.rename(destination)
    except BaseException:
        if backup.exists():
            backup.rename(destination)
        raise
print(f'Installed {destination}')
print(f'CLI: "{destination}/Contents/MacOS/TaskSquad" --version')
PY

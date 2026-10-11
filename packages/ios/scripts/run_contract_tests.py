"""Start only a test-owned server; always stop it and preserve Xcode evidence."""
import json, pathlib, subprocess, time, urllib.request, sys, os
root = pathlib.Path(__file__).resolve().parent.parent
log = root / '.build' / 'fixture-server.log'
log.parent.mkdir(parents=True, exist_ok=True)
try:
    urllib.request.urlopen('http://127.0.0.1:18743/__test/state', timeout=1)
except OSError: pass
else: raise SystemExit('Port 18743 already has a fixture; stop its owner before testing.')
(root / '.build/fixture-events.jsonl').write_text('')
with log.open('w') as output:
    server = subprocess.Popen([sys.executable, str(root/'scripts/workspace_fixture.py')], stdout=output, stderr=output)
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen('http://127.0.0.1:18743/__test/state', timeout=1); break
            except OSError: time.sleep(.1)
        else: raise RuntimeError('Fixture failed to start; inspect fixture-server.log')
        env = dict(os.environ, TSQ_API_METRICS=str(root / '.build/macos-api-metrics.json'))
        baseline = subprocess.run(['/usr/bin/make', 'test'], cwd=root.parent/'mobile/TaskSquadPortal', env=env)
        if baseline.returncode: raise SystemExit(baseline.returncode)
        result = subprocess.run(['/usr/bin/make', 'test'], cwd=root)
        raise SystemExit(result.returncode)
    finally:
        server.terminate(); server.wait(timeout=10)

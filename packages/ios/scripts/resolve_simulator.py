"""Print `SIMULATOR=<name>` and `SIMULATOR_OS=<version>` for the newest installed
iOS runtime that has an available iPhone, preferring a Pro model. Exits non-zero
when none exists, so CI fails instead of silently skipping simulator tests."""
import json, re, subprocess, sys

devices = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '-j']))['devices']
candidates = []
for runtime, entries in devices.items():
    match = re.search(r'SimRuntime\.iOS-(\d+)-(\d+)', runtime)
    if not match:
        continue
    version = (int(match[1]), int(match[2]))
    for device in entries:
        if device.get('isAvailable', True) and device['name'].startswith('iPhone'):
            candidates.append((version, 'Pro' in device['name'], device['name']))
if not candidates:
    sys.exit('No available iPhone simulator with an iOS runtime is installed.')
(major, minor), _, name = max(candidates)
print(f'SIMULATOR={name}')
print(f'SIMULATOR_OS={major}.{minor}')

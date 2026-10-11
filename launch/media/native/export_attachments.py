"""Copies named screenshots from `xcresulttool export attachments` output to <out>/<name>.png."""
import json, shutil, sys, pathlib

src, out = map(pathlib.Path, sys.argv[1:])
for test in json.loads((src / 'manifest.json').read_text()):
    for attachment in test['attachments']:
        name = attachment['suggestedHumanReadableName'].split('_0_')[0].removesuffix('.png')
        if not name.startswith('ios-'): continue  # XCTest's own diagnostics
        shutil.copy(src / attachment['exportedFileName'], out / f'{name}.png')
        print('  ' + name)

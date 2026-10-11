"""Export reviewable, named evidence; refuse failed or incomplete test bundles."""
import argparse, json, pathlib, shutil, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('result', type=pathlib.Path)
parser.add_argument('--output', type=pathlib.Path, default=root/'screenshots/workspace-contract-run')
parser.add_argument('--name', default='full')
args = parser.parse_args()
def query(kind):
    return json.loads(subprocess.check_output(['xcrun','xcresulttool','get','test-results',kind,'--path',str(args.result)]))
summary = query('summary')
if summary.get('result') != 'Passed':
    raise SystemExit('Evidence bundle must have passed: '+str(summary.get('result')))
args.output.mkdir(parents=True,exist_ok=True)
(args.output/(args.name+'-summary.json')).write_text(json.dumps(summary,indent=2)+'\n')
(args.output/(args.name+'-tests.json')).write_text(json.dumps(query('tests'),indent=2)+'\n')
with tempfile.TemporaryDirectory() as temp:
    subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(args.result),'--output-path',temp],check=True)
    manifest = json.loads((pathlib.Path(temp)/'manifest.json').read_text())
    exported=[]
    for test in manifest:
        for item in test.get('attachments',[]):
            name = item.get('suggestedHumanReadableName','')
            source = pathlib.Path(temp)/item['exportedFileName']
            if name.startswith(tuple(str(i).zfill(2)+'-' for i in range(100))) and source.suffix == '.png':
                dest = name.split('_')[0]+'.png'
            elif name.startswith('iOS matched Portal API timings') and source.suffix == '.json':
                dest = 'ios-api-metrics.json'
            else: continue
            shutil.copyfile(source,args.output/dest)
            exported.append(dict(file=dest,test=test['testIdentifier'],timestamp=item.get('timestamp'),device=item.get('deviceName')))
    (args.output/(args.name+'-attachments.json')).write_text(json.dumps(exported,indent=2)+'\n')
for source,dest in [('fixture-events.jsonl',args.name+'-fixture-events.jsonl'),('macos-api-metrics.json',('macos-api-metrics.json' if args.name == 'full' else args.name+'-macos-api-metrics.json'))]:
    path=root/'.build'/source
    if path.exists(): shutil.copyfile(path,args.output/dest)
print(args.output)

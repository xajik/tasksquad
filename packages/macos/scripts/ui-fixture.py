#!/usr/bin/env python3
"""Disposable loopback/tmux fixture for testing the installed native UI."""
import http.server, json, os, pathlib, signal, subprocess, sys, time, uuid
BASE = pathlib.Path(__file__).resolve().parent.parent / '.build' / 'ui-fixture'
SCRIPT = pathlib.Path(__file__).resolve()

def write(path, value):
    path.write_text(json.dumps(value))

def event(state, text):
    with open(state['journal'], 'a') as output:
        output.write(json.dumps({'type': 'agent_turn', 'body': text, 'ts': time.strftime('%Y-%m-%dT%H:%M:%S')}) + '\n')
    with open(state['log'], 'a') as output:
        output.write(time.strftime('%H:%M:%S') + ' [EVENT] ' + text + '\n')

if sys.argv[1] == 'tui':
    import curses
    state = json.loads((BASE / 'state.json').read_text())
    def main(screen):
        curses.curs_set(1)
        selected, typed, last = 0, '', 'Ready for native keyboard input'
        options = ['Inspect logs', 'Continue work', 'Review changes']
        while True:
            screen.erase()
            lines = ['TASKSQUAD / Native terminal test', '', 'Arrow keys choose an action. Enter selects. Type a message and Enter to send.', '']
            for n, line in enumerate(lines):
                screen.addnstr(n, 2, line, max(1, screen.getmaxyx()[1] - 4))
            for n, label in enumerate(options):
                screen.addnstr(4 + n, 4, ('> ' if n == selected else '  ') + label, max(1, screen.getmaxyx()[1] - 8), curses.A_REVERSE if n == selected else 0)
            screen.addnstr(9, 2, last, max(1, screen.getmaxyx()[1] - 4))
            screen.addnstr(11, 2, 'Unicode: 猫 日本語 · café · 🚀', max(1, screen.getmaxyx()[1] - 4))
            screen.addnstr(13, 2, '> ' + typed, max(1, screen.getmaxyx()[1] - 4))
            screen.refresh()
            key = screen.get_wch()
            if key == curses.KEY_DOWN: selected = (selected + 1) % 3
            elif key == curses.KEY_UP: selected = (selected - 1) % 3
            elif key in ('\n', '\r'):
                last = 'Echo: ' + typed if typed else 'Selected: ' + options[selected]
                typed = ''
                event(state, last)
                state['mode'] = 'running' if selected == 1 else 'waiting_input'
                write(BASE / 'state.json', state)
            elif key in (curses.KEY_BACKSPACE, '\x7f', '\b'): typed = typed[:-1]
            elif isinstance(key, str) and key.isprintable(): typed += key
    curses.wrapper(main)
    sys.exit()

if sys.argv[1] == 'serve':
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            state = json.loads((BASE / 'state.json').read_text())
            agent = dict(id='native-ui-builder', name='Builder', mode=state['mode'], task_id=state['task'],
                         log_path=state['log'], session='tsq-native-ui-builder', pull_ago='just now',
                         work_dir=str(BASE), command='fixture TUI', provider='stdout')
            body = json.dumps({'agents': [agent]}).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
        def log_message(self, *_): pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    (BASE / 'port').write_text(str(server.server_port))
    server.serve_forever()
    sys.exit()

if sys.argv[1] == 'start':
    BASE.mkdir(parents=True, exist_ok=True)
    if (BASE / 'manifest.json').exists():
        raise SystemExit('A fixture already exists. Run make ui-fixture-down first.')
    token = uuid.uuid4().hex[:12]
    task = 'native-ui-e2e-' + token
    socket = '/tmp/tsq-ui-e2e-' + token + '.sock'
    root = pathlib.Path.home() / '.tasksquad'
    journal = root / 'tasks' / (task + '.jsonl')
    log = BASE / 'live.log'
    journal.parent.mkdir(parents=True, exist_ok=True)
    state = dict(task=task, journal=str(journal), log=str(log), mode='waiting_input')
    write(BASE / 'state.json', state)
    journal.write_text(json.dumps({'type':'task_start', 'subject':'Verify the native workspace', 'ts':time.strftime('%Y-%m-%dT%H:%M:%S')})+'\n')
    event(state, 'Ready. Open the terminal to continue.')
    (BASE / 'port').unlink(missing_ok=True)
    with (BASE / 'server.log').open('w') as output:
        server = subprocess.Popen([sys.executable, str(SCRIPT), 'serve'], stdout=output, stderr=output, start_new_session=True)
    write(BASE / 'manifest.json', dict(pid=server.pid, socket=socket, journal=str(journal)))
    for _ in range(100):
        if (BASE / 'port').exists(): break
        time.sleep(.03)
    port = int((BASE / 'port').read_text())
    config = "[server]\nurl = 'http://127.0.0.1:%d'\n[ui]\nport = %d\n[[agents]]\nid = 'native-ui-builder'\nname = 'Builder'\ncommand = 'fixture TUI'\nprovider = 'claude-code'\nwork_dir = '%s'\n" % (port, port, BASE)
    (BASE / 'config.toml').write_text(config)
    (BASE / 'handoff.md').write_text('# Agent handoff\n\nA **native preview** with readable text and `inline code`.\n\n## Verification\n\n- [x] Attach to the live TUI\n- [ ] Review the next action\n\n> Detach keeps the agent running.\n\n```swift\nawait session.send("Continue")\n```\n\n| Agent | Status |\n| --- | --- |\n| Builder | Waiting for input |\n')
    (BASE / 'task.json').write_text('{"task_id":90071992547409931234,"agent":"Builder","active":true,"progress":0.85,"steps":["Inspect logs","Continue work","Review changes"],"note":null}')
    subprocess.run(['tmux','-S',socket,'-f','/dev/null','new-session','-d','-s','tsq-native-ui-builder','-x','100','-y','30',sys.executable,str(SCRIPT),'tui'], check=True)
    subprocess.run(['tmux','-S',socket,'new-session','-d','-s','unrelated-test-session','/bin/sleep','3600'], check=True)
    print('Config:', BASE / 'config.toml'); print('Socket:', socket)
    sys.exit()

if sys.argv[1] == 'stop':
    manifest = json.loads((BASE / 'manifest.json').read_text())
    args = subprocess.run(['/bin/ps','-p',str(manifest['pid']),'-o','command='],capture_output=True,text=True).stdout
    if str(SCRIPT) + ' serve' in args: os.kill(manifest['pid'], signal.SIGTERM)
    if manifest['socket'].startswith('/tmp/tsq-ui-e2e-'):
        subprocess.run(['tmux','-S',manifest['socket'],'kill-server'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    journal = pathlib.Path(manifest['journal'])
    if journal.parent == pathlib.Path.home()/'.tasksquad'/'tasks' and journal.name.startswith('native-ui-e2e-'): journal.unlink(missing_ok=True)
    (BASE / 'manifest.json').unlink()
    print('Stopped fixture server and sessions; removed its disposable journal.')

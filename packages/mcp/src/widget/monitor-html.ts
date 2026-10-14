// UI for the open_monitor tool, rendered by ChatGPT (and other MCP Apps hosts) in a
// sandboxed iframe. Self-contained: no external scripts, styles or network access; it
// talks to the host only through the MCP Apps postMessage bridge (window.openai as a
// fallback). Colors follow DESIGN.md. Keep it free of backticks and "${" — it lives in a
// template literal.
export const MONITOR_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TaskSquad monitor</title>
<style>
:root {
  --bg: #FFFFFF; --fg: #0F172A; --muted: #F1F5F9; --muted-fg: #64748B; --border: #E2E8F0;
  --brand: #2563EB; --green: #16A34A; --amber: #D97706; --red: #DC2626; --live: #22C55E;
  --amber-tint: #FFFBEB; --amber-border: #FDE68A;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #17191E; --fg: #E7E9ED; --muted: #22252C; --muted-fg: #A0A7B4; --border: #2E323B;
    --brand: #7AA7FF; --green: #4ADE80; --amber: #FBBF24; --red: #F87171;
    --amber-tint: rgba(245, 158, 11, 0.15); --amber-border: rgba(245, 158, 11, 0.3);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #17191E; --fg: #E7E9ED; --muted: #22252C; --muted-fg: #A0A7B4; --border: #2E323B;
  --brand: #7AA7FF; --green: #4ADE80; --amber: #FBBF24; --red: #F87171;
  --amber-tint: rgba(245, 158, 11, 0.15); --amber-border: rgba(245, 158, 11, 0.3);
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
button, select { font: inherit; color: inherit; }
.top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.brand { font-weight: 700; }
.top select { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 2px 6px; max-width: 220px; }
.spacer { flex: 1; }
.meta { color: var(--muted-fg); font-size: 12px; }
.btn { background: transparent; border: 1px solid var(--border); border-radius: 6px; padding: 3px 10px; cursor: pointer; font-size: 12px; }
.btn:hover { background: var(--muted); }
.btn:disabled { opacity: 0.5; cursor: default; }
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 14px; }
.stat { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.stat b { display: block; font-size: 18px; }
.stat span { color: var(--muted-fg); font-size: 12px; }
.stat.warn { background: var(--amber-tint); border-color: var(--amber-border); }
.agents { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted-fg); flex: none; }
.dot.idle { background: var(--live); }
.dot.running, .dot.wrapping_up { background: var(--brand); }
.dot.waiting_input { background: var(--amber); }
.dot.done { background: var(--green); }
.dot.failed { background: var(--red); }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted-fg); margin: 14px 0 6px; }
.task { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--border); }
.task .body { flex: 1; min-width: 0; }
.task .subject { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task .actions { display: flex; gap: 6px; flex: none; }
.empty, .error { color: var(--muted-fg); padding: 12px 0; }
.error { color: var(--red); }
@media (max-width: 480px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
</head>
<body>
<div id="root"><div class="empty">Loading your agents…</div></div>
<script>
(function () {
  var REFRESH_MS = 20000;
  var AUTO_REFRESH_FOR_MS = 15 * 60 * 1000;
  var state = { snap: null, teamId: null, loading: false, error: null, updatedAt: 0, autoUntil: Date.now() + AUTO_REFRESH_FOR_MS };
  var nextId = 1;
  var pending = {};
  var root = document.getElementById('root');

  // ── MCP Apps bridge (JSON-RPC 2.0 over postMessage) ──────────────────
  function post(msg) { window.parent.postMessage(msg, '*'); }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new Error('The host did not answer ' + method)); }
      }, 30000);
    });
  }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id != null && !m.method) {
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      if (m.error) p.reject(new Error(m.error.message || 'Request failed'));
      else p.resolve(m.result);
      return;
    }
    if (m.method === 'ui/notifications/tool-result') applyResult(m.params);
    else if (m.method === 'ui/notifications/tool-input') {
      var args = m.params && m.params.arguments;
      if (args && args.team_id) state.teamId = args.team_id;
    } else if (m.method === 'ui/notifications/host-context-changed') applyContext(m.params);
    else if (m.id != null) post({ jsonrpc: '2.0', id: m.id, result: {} });
  });

  function openai() { return window.openai || null; }

  function callTool(name, args) {
    return request('tools/call', { name: name, arguments: args }).catch(function (err) {
      if (openai() && openai().callTool) return openai().callTool(name, args);
      throw err;
    });
  }
  function openLink(url) {
    request('ui/open-link', { url: url }).catch(function () {
      if (openai() && openai().openExternal) openai().openExternal({ href: url });
      else window.open(url, '_blank', 'noopener');
    });
  }
  function followUp(text) {
    if (openai() && openai().sendFollowUpMessage) { openai().sendFollowUpMessage({ prompt: text }); return; }
    request('ui/message', { role: 'user', content: [{ type: 'text', text: text }] }).catch(function () {});
  }
  function fullscreen() {
    if (openai() && openai().requestDisplayMode) { openai().requestDisplayMode({ mode: 'fullscreen' }); return; }
    request('ui/request-display-mode', { mode: 'fullscreen' }).catch(function () {});
  }

  function applyContext(ctx) {
    if (ctx && (ctx.theme === 'light' || ctx.theme === 'dark')) document.documentElement.setAttribute('data-theme', ctx.theme);
  }
  function applyResult(result) {
    if (!result) return;
    if (result.isError) {
      var t = result.content && result.content[0] && result.content[0].text;
      state.error = t || 'TaskSquad returned an error.';
    } else if (result.structuredContent) {
      state.snap = result.structuredContent;
      state.error = null;
      if (state.snap.project) state.teamId = state.snap.project.id;
    }
    state.updatedAt = Date.now();
    render();
  }

  function refresh(manual) {
    if (state.loading) return;
    if (manual) state.autoUntil = Date.now() + AUTO_REFRESH_FOR_MS;
    state.loading = true;
    render();
    callTool('open_monitor', state.teamId ? { team_id: state.teamId } : {})
      .then(applyResult)
      .catch(function (err) { state.error = err.message; })
      .then(function () { state.loading = false; render(); });
  }

  // ── rendering (textContent only: tool data is untrusted) ─────────────
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function ago(ms) {
    if (!ms) return '';
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  var LABELS = {
    offline: 'offline', idle: 'online', running: 'running', waiting_input: 'needs input',
    wrapping_up: 'wrapping up', pending: 'queued', scheduled: 'scheduled', done: 'done',
    failed: 'failed', cancelled: 'cancelled'
  };
  function label(s) { return LABELS[s] || s; }

  function stat(n, text, warn) {
    var d = el('div', 'stat' + (warn && n > 0 ? ' warn' : ''));
    d.appendChild(el('b', null, String(n)));
    d.appendChild(el('span', null, text));
    return d;
  }
  function taskRow(t, canReply) {
    var row = el('div', 'task');
    row.appendChild(el('span', 'dot ' + t.status));
    var body = el('div', 'body');
    body.appendChild(el('div', 'subject', t.subject));
    body.appendChild(el('div', 'meta', t.agent_name + ' · ' + label(t.status) + ' · ' + ago(t.updated_at)));
    row.appendChild(body);
    var actions = el('div', 'actions');
    if (canReply) {
      var reply = el('button', 'btn', 'Reply');
      reply.onclick = function () { followUp('Help me reply to TaskSquad task ' + t.id + ' ("' + t.subject + '"). Show me what the agent asked first.'); };
      actions.appendChild(reply);
    }
    var open = el('button', 'btn', 'Open');
    open.onclick = function () { openLink(t.url); };
    actions.appendChild(open);
    row.appendChild(actions);
    return row;
  }
  function section(title, tasks, canReply) {
    if (!tasks.length) return null;
    var s = el('div');
    s.appendChild(el('h3', null, title + ' (' + tasks.length + ')'));
    tasks.forEach(function (t) { s.appendChild(taskRow(t, canReply)); });
    return s;
  }

  function render() {
    var snap = state.snap;
    root.textContent = '';
    var top = el('div', 'top');
    top.appendChild(el('span', 'brand', 'TaskSquad'));
    if (snap && snap.projects && snap.projects.length > 1) {
      var sel = el('select');
      sel.setAttribute('aria-label', 'Project');
      snap.projects.forEach(function (p) {
        var o = el('option', null, p.name);
        o.value = p.id;
        if (snap.project && p.id === snap.project.id) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = function () { state.teamId = sel.value; refresh(true); };
      top.appendChild(sel);
    } else if (snap && snap.project) {
      top.appendChild(el('span', 'meta', snap.project.name));
    }
    top.appendChild(el('span', 'spacer'));
    var auto = Date.now() < state.autoUntil;
    top.appendChild(el('span', 'meta', state.loading ? 'Refreshing…' :
      state.updatedAt ? 'Updated ' + ago(state.updatedAt) + (auto ? '' : ' · auto-refresh paused') : ''));
    var r = el('button', 'btn', 'Refresh');
    r.disabled = state.loading;
    r.onclick = function () { refresh(true); };
    top.appendChild(r);
    var f = el('button', 'btn', 'Expand');
    f.onclick = fullscreen;
    top.appendChild(f);
    root.appendChild(top);

    if (state.error) root.appendChild(el('div', 'error', state.error));
    if (!snap) { if (!state.error) root.appendChild(el('div', 'empty', 'Loading your agents…')); return; }
    if (!snap.project) {
      root.appendChild(el('div', 'empty', 'No TaskSquad projects yet. Ask ChatGPT to create one, or open tasksquad.ai.'));
      return;
    }

    var online = snap.agents.filter(function (a) { return a.status !== 'offline'; }).length;
    var stats = el('div', 'stats');
    stats.appendChild(stat(online, 'of ' + snap.agents.length + ' agents online'));
    stats.appendChild(stat(snap.needs_input.length, 'need input', true));
    stats.appendChild(stat(snap.running.length, 'running'));
    stats.appendChild(stat(snap.queued.length, 'queued'));
    root.appendChild(stats);

    if (snap.agents.length) {
      var agents = el('div', 'agents');
      snap.agents.forEach(function (a) {
        var c = el('span', 'chip');
        c.appendChild(el('span', 'dot ' + a.status));
        c.appendChild(el('span', null, a.name + ' · ' + (a.paused ? 'paused' : label(a.status))));
        if (a.status === 'offline' && a.last_seen) c.title = 'Last seen ' + ago(a.last_seen);
        agents.appendChild(c);
      });
      root.appendChild(agents);
    } else {
      root.appendChild(el('div', 'empty', 'No agents in this project yet.'));
    }

    var parts = [
      section('Needs your input', snap.needs_input, true),
      section('Running', snap.running, false),
      section('Queued', snap.queued, false),
      section('Recently finished', snap.recent, false)
    ].filter(Boolean);
    if (!parts.length) root.appendChild(el('div', 'empty', 'No tasks yet. Ask ChatGPT to send one to an agent.'));
    parts.forEach(function (p) { root.appendChild(p); });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────
  if ('ResizeObserver' in window) {
    new ResizeObserver(function () {
      notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight });
    }).observe(document.body);
  }
  window.addEventListener('openai:set_globals', function () {
    var o = openai();
    if (!o) return;
    applyContext({ theme: o.theme });
    if (o.toolOutput && !state.snap) applyResult({ structuredContent: o.toolOutput });
  });
  if (openai()) {
    applyContext({ theme: openai().theme });
    if (openai().toolOutput) applyResult({ structuredContent: openai().toolOutput });
  }

  request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'tasksquad-monitor', version: '1.0.0' },
    appCapabilities: {}
  }).then(function (res) {
    if (res && res.hostContext) applyContext(res.hostContext);
    notify('ui/notifications/initialized');
  }).catch(function () {});

  setInterval(function () {
    if (document.visibilityState !== 'visible' || !state.snap) { render(); return; }
    if (Date.now() < state.autoUntil) refresh(false); else render();
  }, REFRESH_MS);
  render();
})();
</script>
</body>
</html>
`

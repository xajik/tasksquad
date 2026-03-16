//go:build cgo && darwin

package ui

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// dashboardHTML is the single-page control panel served at the local HTTP server.
// Visual design mirrors the TaskSquad portal (packages/portal) — same color tokens,
// card style, button variants, and typography.
const dashboardHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>tsq — Control Panel</title>
<style>
/* ── Design tokens (mirrors packages/portal/src/index.css @theme) ─────────── */
:root {
  --bg:           hsl(0 0% 100%);
  --fg:           hsl(222.2 84% 4.9%);
  --card:         hsl(0 0% 100%);
  --primary:      hsl(222.2 47.4% 11.2%);
  --primary-fg:   hsl(210 40% 98%);
  --secondary:    hsl(210 40% 96.1%);
  --secondary-fg: hsl(222.2 47.4% 11.2%);
  --muted:        hsl(210 40% 96.1%);
  --muted-fg:     hsl(215.4 16.3% 46.9%);
  --border:       hsl(214.3 31.8% 91.4%);
  --destructive:  hsl(0 84.2% 60.2%);
  --destructive-fg: hsl(210 40% 98%);
  --accent-blue:  #2563eb;
  --radius:       0.5rem;
}

/* ── Reset ─────────────────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  background: var(--muted);
  color: var(--fg);
  min-height: 100vh;
}

/* ── Header ────────────────────────────────────────────────────────────────── */
header {
  background: var(--card);
  border-bottom: 1px solid var(--border);
  padding: 0 24px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: sticky;
  top: 0;
  z-index: 20;
}
.header-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.brand-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-blue);
  flex-shrink: 0;
}
.brand-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
  letter-spacing: -0.2px;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.email-label {
  font-size: 13px;
  color: var(--muted-fg);
}
.refresh-label {
  font-size: 12px;
  color: var(--muted-fg);
}

/* ── Buttons (mirrors portal button.tsx) ───────────────────────────────────── */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 12px;
  height: 32px;
  border-radius: var(--radius);
  border: none;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s, background 0.15s;
  white-space: nowrap;
  text-decoration: none;
}
.btn:disabled { opacity: 0.45; cursor: default; pointer-events: none; }
.btn-default  { background: var(--primary); color: var(--primary-fg); }
.btn-default:hover { opacity: 0.9; }
.btn-secondary { background: var(--secondary); color: var(--secondary-fg); }
.btn-secondary:hover { background: hsl(210 40% 92%); }
.btn-ghost { background: transparent; color: var(--fg); }
.btn-ghost:hover { background: var(--secondary); }
.btn-destructive { background: var(--destructive); color: var(--destructive-fg); }
.btn-destructive:hover { opacity: 0.9; }
.btn-sm { height: 28px; padding: 0 10px; font-size: 12px; }

/* ── Layout ────────────────────────────────────────────────────────────────── */
.page { max-width: 960px; margin: 0 auto; padding: 20px 24px; }
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 640px) { .grid-2 { grid-template-columns: 1fr; } }

/* ── Card (mirrors portal card.tsx) ────────────────────────────────────────── */
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 1px 2px rgba(0,0,0,.04);
  overflow: hidden;
}
.card-header {
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
.card-subtitle {
  font-size: 12px;
  color: var(--muted-fg);
  margin-top: 1px;
}

/* ── Row items ──────────────────────────────────────────────────────────────── */
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  transition: background 0.1s;
}
.row:last-child { border-bottom: none; }
.row:hover { background: var(--muted); }

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot-running  { background: #16a34a; }
.dot-waiting  { background: #d97706; }
.dot-idle     { background: hsl(215.4 16.3% 70%); }
.dot-orphan   { background: var(--destructive); }

.row-info { flex: 1; min-width: 0; }
.row-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-sub {
  font-size: 12px;
  color: var(--muted-fg);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-actions { display: flex; gap: 6px; flex-shrink: 0; align-items: center; }

/* ── Badges ─────────────────────────────────────────────────────────────────── */
.badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.6;
}
.badge-running  { background: #dcfce7; color: #166534; }
.badge-waiting  { background: #fef3c7; color: #92400e; }
.badge-idle     { background: var(--secondary); color: var(--muted-fg); }
.badge-orphan   { background: #fee2e2; color: #991b1b; }
.badge-linked   { background: #dbeafe; color: #1e40af; }

/* ── Empty state ────────────────────────────────────────────────────────────── */
.empty {
  padding: 32px 16px;
  text-align: center;
  color: var(--muted-fg);
  font-size: 13px;
}

/* ── Log panel ──────────────────────────────────────────────────────────────── */
.log-panel {
  display: none;
  margin-top: 16px;
  background: hsl(222.2 47.4% 7%);
  border: 1px solid hsl(222.2 30% 18%);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0,0,0,.12);
}
.log-panel.open { display: block; animation: fade-in 0.2s ease-out; }
.log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid hsl(222.2 30% 18%);
  background: hsl(222.2 47.4% 9%);
}
.log-title {
  font-size: 12px;
  font-weight: 500;
  color: hsl(210 40% 70%);
  font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
.log-body {
  max-height: 340px;
  overflow-y: auto;
  padding: 14px 16px;
}
pre {
  font-family: ui-monospace, "JetBrains Mono", Menlo, Monaco, monospace;
  font-size: 11.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-all;
  color: hsl(210 40% 88%);
}

/* ── Animation ──────────────────────────────────────────────────────────────── */
@keyframes fade-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
.animate-in { animation: fade-in 0.2s ease-out; }

/* ── Spinner ─────────────────────────────────────────────────────────────────── */
.spinner {
  display: inline-block;
  width: 14px; height: 14px;
  border: 2px solid var(--border);
  border-top-color: var(--accent-blue);
  border-radius: 50%;
  animation: spin 0.65s linear infinite;
  vertical-align: middle;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>

<header>
  <div class="header-brand">
    <div class="brand-dot"></div>
    <span class="brand-name">tsq Control Panel</span>
  </div>
  <div class="header-right">
    <span class="email-label" id="email-label"></span>
    <span class="refresh-label" id="refresh-label"></span>
    <button class="btn btn-secondary" onclick="showDaemonLog()">Daemon Logs</button>
    <button class="btn btn-default" onclick="openPortal()">Open Web Portal</button>
  </div>
</header>

<div class="page">
  <div class="grid-2">

    <!-- Agents -->
    <div class="card animate-in">
      <div class="card-header">
        <div>
          <div class="card-title">Agents</div>
          <div class="card-subtitle" id="agents-subtitle"></div>
        </div>
      </div>
      <div id="agents-list"><div class="empty"><span class="spinner"></span></div></div>
    </div>

    <!-- Sessions -->
    <div class="card animate-in" style="animation-delay:.05s">
      <div class="card-header">
        <div>
          <div class="card-title">Sessions</div>
          <div class="card-subtitle">tmux managed</div>
        </div>
      </div>
      <div id="sessions-list"><div class="empty"><span class="spinner"></span></div></div>
    </div>

  </div>

  <!-- Log viewer -->
  <div class="log-panel" id="log-panel">
    <div class="log-header">
      <span class="log-title" id="log-title">log</span>
      <button class="btn btn-ghost btn-sm" style="color:hsl(210 40% 70%)" onclick="closeLog()">Close</button>
    </div>
    <div class="log-body" id="log-body"><pre id="log-pre"></pre></div>
  </div>
</div>

<script>
let DASH_URL = '';
let PORTAL_URL = '';
let activeLog = null; // {url: string} | null
let logTimer = null;

async function load() {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) return;
    const d = await r.json();
    DASH_URL = d.dash_url || '';
    PORTAL_URL = d.portal_url || '';
    document.getElementById('email-label').textContent = d.email || '';
    document.getElementById('refresh-label').textContent = 'updated ' + ago(d.updated_at);
    renderAgents(d.agents || []);
    renderSessions(d.sessions || []);
  } catch(e) { console.error(e); }
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  return Math.round(s / 60) + 'm ago';
}

function dotClass(mode) {
  return {running:'dot-running', waiting_input:'dot-waiting', idle:'dot-idle'}[mode] || 'dot-idle';
}
function badgeClass(mode) {
  return {running:'badge-running', waiting_input:'badge-waiting', idle:'badge-idle'}[mode] || 'badge-idle';
}
function modeLabel(mode) {
  return {running:'running', waiting_input:'waiting', idle:'idle'}[mode] || (mode || 'idle');
}

function renderAgents(agents) {
  const el = document.getElementById('agents-list');
  const sub = document.getElementById('agents-subtitle');
  const running = agents.filter(a => a.mode === 'running').length;
  const waiting = agents.filter(a => a.mode === 'waiting_input').length;
  sub.textContent = running + ' running · ' + waiting + ' waiting · ' + (agents.length - running - waiting) + ' idle';
  if (!agents.length) { el.innerHTML = '<div class="empty">No agents configured</div>'; return; }
  el.innerHTML = agents.map(a => {
    const logBtn = a.task_id
      ? '<button class="btn btn-secondary btn-sm" onclick="showAgentLog(event,' + q(a.name) + ',' + q(a.task_id) + ')">Logs</button>'
      : '';
    const sub = a.task_id
      ? 'task ' + a.task_id.slice(0,10) + '… · pull ' + a.pull_ago
      : 'pull ' + a.pull_ago;
    return row(
      '<div class="status-dot ' + dotClass(a.mode) + '"></div>',
      x(a.name), sub,
      '<span class="badge ' + badgeClass(a.mode) + '">' + modeLabel(a.mode) + '</span>' + logBtn
    );
  }).join('');
}

function renderSessions(sessions) {
  const el = document.getElementById('sessions-list');
  if (!sessions.length) { el.innerHTML = '<div class="empty">No active tsq sessions</div>'; return; }
  el.innerHTML = sessions.map(s => {
    const dotCls = s.orphan ? 'dot-orphan' : 'dot-running';
    const badgeCls = s.orphan ? 'badge-orphan' : 'badge-linked';
    const badgeTxt = s.orphan ? 'orphan' : 'linked';
    const sub = s.orphan ? 'no linked agent' : 'agent: ' + x(s.agent_name);
    const logBtn = s.task_id
      ? '<button class="btn btn-secondary btn-sm" onclick="showSessionLog(event,' + x(JSON.stringify(s)) + ')">Logs</button>'
      : '';
    const killBtn = '<button class="btn btn-destructive btn-sm" onclick="killSession(event,' + q(s.name) + ')">Kill</button>';
    return row(
      '<div class="status-dot ' + dotCls + '"></div>',
      x(s.name), sub,
      '<span class="badge ' + badgeCls + '">' + badgeTxt + '</span>' + logBtn + killBtn
    );
  }).join('');
}

function row(icon, name, sub, actions) {
  return '<div class="row">' + icon +
    '<div class="row-info"><div class="row-name">' + name + '</div><div class="row-sub">' + sub + '</div></div>' +
    '<div class="row-actions">' + actions + '</div>' +
    '</div>';
}

async function showAgentLog(e, agentName, taskId) {
  e.stopPropagation();
  if (!taskId) return;
  const url = '/api/logs?agent=' + encodeURIComponent(agentName) + '&task=' + encodeURIComponent(taskId);
  openLog(agentName + ' · ' + taskId.slice(0, 14) + '…', url, true);
}

async function showSessionLog(e, session) {
  e.stopPropagation();
  if (!session.task_id || !session.agent_name) {
    openLog(session.name, null);
    setLog('No log available for orphan sessions.');
    return;
  }
  await showAgentLog(e, session.agent_name, session.task_id);
}

async function killSession(e, name) {
  e.stopPropagation();
  if (!confirm('Kill session ' + name + '?\n\nThe task will remain on the server; the daemon will clean up on the next heartbeat.')) return;
  try {
    const r = await fetch('/api/session/kill', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name}),
    });
    if (r.ok || r.status === 204) load();
    else alert('Kill failed: ' + await r.text());
  } catch(e) { alert('Error: ' + e.message); }
}

function openPortal() { if (PORTAL_URL) window.open(PORTAL_URL, '_blank'); }

function openLog(title, url, poll = false) {
  activeLog = (url && poll) ? {url} : null;
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
  document.getElementById('log-title').textContent = title;
  document.getElementById('log-pre').textContent = 'Loading…';
  const panel = document.getElementById('log-panel');
  panel.classList.add('open');
  panel.scrollIntoView({behavior: 'smooth', block: 'start'});
  if (url) fetchLog(url);
  if (poll) startLogPolling();
}

async function fetchLog(url) {
  try {
    const r = await fetch(url);
    setLog(r.ok ? await r.text() : 'Log not found.');
  } catch(e) { setLog('Error: ' + e.message); }
}

function setLog(text) {
  const pre = document.getElementById('log-pre');
  const body = document.getElementById('log-body');
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  pre.textContent = text;
  if (atBottom) body.scrollTop = body.scrollHeight;
}

function startLogPolling() {
  if (logTimer) clearInterval(logTimer);
  logTimer = setInterval(() => {
    if (activeLog) fetchLog(activeLog.url);
  }, 2000);
}

function closeLog() {
  document.getElementById('log-panel').classList.remove('open');
  activeLog = null;
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
}

/* XSS-safe string escaping */
function x(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function q(s) { return x(JSON.stringify(String(s || ''))); }

function showDaemonLog() {
  openLog('daemon · today', '/api/logs/daemon');
}

load();
showDaemonLog();
setInterval(load, 5000);
</script>
</body>
</html>`

type dashStatus struct {
	Email     string        `json:"email"`
	DashURL   string        `json:"dash_url"`
	PortalURL string        `json:"portal_url"` // /dashboard if logged in, /auth otherwise
	Agents    []dashAgent   `json:"agents"`
	Sessions  []dashSession `json:"sessions"`
	UpdatedAt int64         `json:"updated_at"`
}

type dashAgent struct {
	Name    string `json:"name"`
	Mode    string `json:"mode"`
	TaskID  string `json:"task_id"`
	LogPath string `json:"log_path"`
	Session string `json:"session"`
	PullAgo string `json:"pull_ago"`
}

type dashSession struct {
	Name      string `json:"name"`
	AgentName string `json:"agent_name"`
	TaskID    string `json:"task_id"`
	Orphan    bool   `json:"orphan"`
}

// StartDashboard starts a local HTTP control panel server and returns the URL.
// The server provides status, log reading, and session kill endpoints.
func StartDashboard(agents []AgentStatus, email, dashURL string) string {
	mux := http.NewServeMux()

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(dashboardHTML)) //nolint:errcheck
	})

	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		// Map session suffix → (agentName, taskID) for linked sessions.
		type linked struct{ agent, task string }
		byPrefix := map[string]linked{}
		for _, a := range agents {
			tid := a.GetTaskID()
			if tid == "" {
				continue
			}
			prefix := tid
			if len(prefix) > 8 {
				prefix = prefix[:8]
			}
			byPrefix[prefix] = linked{a.Name(), tid}
		}

		var agts []dashAgent
		for _, a := range agents {
			ago := "never"
			if t := a.LastPullTime(); !t.IsZero() {
				ago = relTime(t)
			}
			agts = append(agts, dashAgent{
				Name:    a.Name(),
				Mode:    a.GetMode(),
				TaskID:  a.GetTaskID(),
				LogPath: a.LastLogPath(),
				Session: a.TmuxSession(),
				PullAgo: ago,
			})
		}

		var sessions []dashSession
		out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").Output()
		if err == nil {
			for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
				line = strings.TrimSpace(line)
				if !strings.HasPrefix(line, "tsq-") || line == "" {
					continue
				}
				suffix := strings.TrimPrefix(line, "tsq-")
				lnk, ok := byPrefix[suffix]
				sessions = append(sessions, dashSession{
					Name:      line,
					AgentName: lnk.agent,
					TaskID:    lnk.task,
					Orphan:    !ok,
				})
			}
		}

		portalURL := dashURL + "/auth"
		if email != "" {
			portalURL = dashURL + "/dashboard"
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(dashStatus{ //nolint:errcheck
			Email:     email,
			DashURL:   dashURL,
			PortalURL: portalURL,
			Agents:    agts,
			Sessions:  sessions,
			UpdatedAt: time.Now().UnixMilli(),
		})
	})

	mux.HandleFunc("/api/logs/daemon", func(w http.ResponseWriter, r *http.Request) {
		home, _ := os.UserHomeDir()
		today := time.Now().Format("2006-01-02")
		path := filepath.Join(home, ".tasksquad", "logs", "daemon-"+today+".log")
		content, err := os.ReadFile(path)
		if err != nil {
			http.Error(w, "daemon log not found: "+path, http.StatusNotFound)
			return
		}
		lines := strings.Split(string(content), "\n")
		if len(lines) > 500 {
			lines = lines[len(lines)-500:]
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte(strings.Join(lines, "\n"))) //nolint:errcheck
	})

	mux.HandleFunc("/api/logs", func(w http.ResponseWriter, r *http.Request) {
		agentName := r.URL.Query().Get("agent")
		taskID := r.URL.Query().Get("task")
		if agentName == "" || taskID == "" {
			http.Error(w, "missing agent or task", http.StatusBadRequest)
			return
		}
		home, _ := os.UserHomeDir()
		safe := dashSanitize(agentName)
		logDir := filepath.Join(home, ".tasksquad", "logs", safe)
		path := filepath.Join(logDir, taskID+".log")

		content, err := os.ReadFile(path)
		if err != nil {
			// Log file missing — pull directly from the tmux session.
			sessionSuffix := taskID
			if len(sessionSuffix) > 8 {
				sessionSuffix = sessionSuffix[:8]
			}
			sessionName := "tsq-" + sessionSuffix
			tmuxOut, tmuxErr := exec.Command("tmux", "capture-pane", "-t", sessionName, "-p", "-S", "-").Output()
			if tmuxErr != nil {
				http.Error(w, "log file not found and no active tmux session", http.StatusNotFound)
				return
			}
			// Persist to file so future reads come from disk.
			os.MkdirAll(logDir, 0755)                    //nolint:errcheck
			os.WriteFile(path, tmuxOut, 0644)             //nolint:errcheck
			content = tmuxOut
		}

		lines := strings.Split(string(content), "\n")
		if len(lines) > 300 {
			lines = lines[len(lines)-300:]
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte(strings.Join(lines, "\n"))) //nolint:errcheck
	})

	mux.HandleFunc("/api/session/kill", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Name string `json:"name"`
		}
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		if body.Name == "" || !strings.HasPrefix(body.Name, "tsq-") {
			http.Error(w, "invalid session name", http.StatusBadRequest)
			return
		}
		if err := exec.Command("tmux", "kill-session", "-t", body.Name).Run(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0") // binds to loopback; URL uses localhost
	if err != nil {
		return ""
	}
	go func() { //nolint:errcheck
		srv := &http.Server{Handler: mux}
		srv.Serve(ln) //nolint:errcheck
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	return fmt.Sprintf("http://localhost:%d", port)
}

// dashSanitize mirrors logger.sanitizeName: replaces non-alphanumeric chars with '-'.
func dashSanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	return b.String()
}

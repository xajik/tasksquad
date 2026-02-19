import { useState, useEffect, useRef, useCallback } from 'react'
import { signOut } from 'firebase/auth'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { auth, getToken } from '../lib/firebase'
import { api, type Agent, type Task, type Message } from '../lib/api'

// ─── Helpers ──────────────────────────────────────────────────────────────────
function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

const STATUS_COLOR: Record<string, string> = {
  pending: '#888', running: '#2563eb', waiting_input: '#d97706',
  done: '#16a34a', failed: '#dc2626', offline: '#aaa', idle: '#16a34a',
  accumulating: '#2563eb', live: '#2563eb', stuck: '#d97706', error: '#dc2626',
}

function StatusPill({ status }: { status: string }) {
  return (
    <span style={{ background: STATUS_COLOR[status] ?? '#888', color: '#fff', borderRadius: 12, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
      {status}
    </span>
  )
}

const S: Record<string, React.CSSProperties> = {
  layout: { display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif', fontSize: 14 },
  sidebar: { width: 200, borderRight: '1px solid #eee', display: 'flex', flexDirection: 'column', padding: '20px 0', background: '#fafafa' },
  logo: { fontWeight: 700, fontSize: 16, padding: '0 20px', marginBottom: 24 },
  navBtn: { background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: '8px 20px', width: '100%', fontSize: 14 },
  main: { flex: 1, overflow: 'auto', padding: 32 },
}

// ─── Team context (simplified — uses first team or creates one) ───────────────
function useTeam() {
  const [teamId, setTeamId] = useState<string | null>(null)
  const [teamName, setTeamName] = useState('')

  useEffect(() => {
    const stored = localStorage.getItem('tsq_team_id')
    if (stored) { setTeamId(stored); setTeamName(localStorage.getItem('tsq_team_name') ?? '') }
  }, [])

  async function createTeam(name: string) {
    const t = await api.teams.create(name)
    localStorage.setItem('tsq_team_id', t.id)
    localStorage.setItem('tsq_team_name', t.name)
    setTeamId(t.id)
    setTeamName(t.name)
  }

  return { teamId, teamName, createTeam }
}

// ─── Inbox ────────────────────────────────────────────────────────────────────
function Inbox({ teamId }: { teamId: string }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [showCompose, setShowCompose] = useState(false)
  const [subject, setSubject] = useState('')
  const [agentId, setAgentId] = useState('')
  const [creating, setCreating] = useState(false)
  const nav = useNavigate()

  const load = useCallback(async () => {
    const [td, ad] = await Promise.all([api.tasks.list(), api.agents.list(teamId)])
    setTasks(td.tasks ?? [])
    setAgents(ad.agents ?? [])
  }, [teamId])

  useEffect(() => { load() }, [load])

  async function compose(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    try {
      await api.tasks.create({ agent_id: agentId, subject })
      setShowCompose(false); setSubject(''); setAgentId('')
      load()
    } finally { setCreating(false) }
  }

  const agentMap = Object.fromEntries(agents.map(a => [a.id, a]))

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>Inbox</h2>
        <button onClick={() => setShowCompose(true)} style={{ padding: '8px 16px', background: '#111', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
          New task
        </button>
      </div>

      {showCompose && (
        <form onSubmit={compose} style={{ background: '#f5f5f5', borderRadius: 8, padding: 20, marginBottom: 24 }}>
          <h3 style={{ margin: '0 0 16px' }}>New task</h3>
          <select value={agentId} onChange={e => setAgentId(e.target.value)} required style={{ display: 'block', width: '100%', marginBottom: 12, padding: 8, borderRadius: 6, border: '1px solid #ddd' }}>
            <option value="">Select agent…</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject" required style={{ display: 'block', width: '100%', marginBottom: 12, padding: 8, borderRadius: 6, border: '1px solid #ddd', boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={creating} style={{ padding: '8px 16px', background: '#111', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              {creating ? '…' : 'Send'}
            </button>
            <button type="button" onClick={() => setShowCompose(false)} style={{ padding: '8px 16px', background: '#eee', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {tasks.length === 0 && <p style={{ color: '#aaa' }}>No tasks yet.</p>}
        {tasks.map(t => (
          <div
            key={t.id}
            onClick={() => nav(`/dashboard/tasks/${t.id}`)}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: '#fff', border: '1px solid #eee', borderRadius: 8, cursor: 'pointer' }}
          >
            <div>
              <div style={{ fontWeight: 500 }}>{t.subject}</div>
              <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>{agentMap[t.agent_id]?.name ?? t.agent_id}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <StatusPill status={t.status} />
              <span style={{ color: '#aaa', fontSize: 12 }}>{relativeTime(t.created_at)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Task Thread ──────────────────────────────────────────────────────────────
function TaskThread() {
  const { taskId } = useParams<{ taskId: string }>()
  const [task, setTask] = useState<Task | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [liveLines, setLiveLines] = useState<string[]>([])
  const [watching, setWatching] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  const load = useCallback(async () => {
    if (!taskId) return
    const [t, m] = await Promise.all([api.tasks.get(taskId), api.messages.list(taskId)])
    setTask(t)
    setMessages(m.messages ?? [])
  }, [taskId])

  useEffect(() => { load() }, [load])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, liveLines])

  async function startLive() {
    if (!task || esRef.current) return
    const token = await getToken()
    const es = new EventSource(`${import.meta.env.VITE_API_BASE_URL}/live/${task.agent_id}?token=${token}`)
    esRef.current = es
    setWatching(true)
    setLiveLines([])
    es.onmessage = (e) => {
      const data = JSON.parse(e.data) as { type: string; text: string }
      if (data.type === 'line') setLiveLines(prev => [...prev, data.text])
      if (data.type === 'backlog') setLiveLines(data.text.split('\n'))
      if (data.type === 'done' || data.type === 'waiting_input') { es.close(); esRef.current = null; setWatching(false); load() }
    }
    es.onerror = () => { es.close(); esRef.current = null; setWatching(false) }
  }

  useEffect(() => () => { esRef.current?.close() }, [])

  async function sendReply(e: React.FormEvent) {
    e.preventDefault()
    if (!taskId || !reply.trim()) return
    setSending(true)
    try {
      await api.messages.create(taskId, reply)
      setReply('')
      load()
    } finally { setSending(false) }
  }

  function roleStyle(role: string): React.CSSProperties {
    if (role === 'user') return { background: '#eff6ff', borderRadius: 8, padding: '10px 14px', alignSelf: 'flex-end', maxWidth: '70%' }
    if (role === 'agent') return { background: '#f5f5f5', borderRadius: 8, padding: '10px 14px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxWidth: '90%' }
    return { color: '#888', fontSize: 12, fontStyle: 'italic', padding: '4px 0' }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <h2 style={{ margin: 0, flex: 1 }}>{task?.subject ?? '…'}</h2>
        {task && <StatusPill status={task.status} />}
        {task && (task.status === 'running') && !watching && (
          <button onClick={startLive} style={{ padding: '6px 12px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
            Watch live
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
        {messages.map(m => (
          <div key={m.id} style={roleStyle(m.role)}>{m.body}</div>
        ))}
        {watching && liveLines.length > 0 && (
          <div style={{ background: '#111', color: '#0f0', borderRadius: 8, padding: '10px 14px', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto' }}>
            {liveLines.join('\n')}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {task?.status === 'waiting_input' && (
        <form onSubmit={sendReply} style={{ display: 'flex', gap: 8 }}>
          <input
            value={reply} onChange={e => setReply(e.target.value)}
            placeholder="Reply to agent…"
            style={{ flex: 1, padding: '10px 12px', border: '1px solid #ddd', borderRadius: 6, fontSize: 14 }}
          />
          <button type="submit" disabled={sending} style={{ padding: '10px 16px', background: '#111', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            {sending ? '…' : 'Send'}
          </button>
        </form>
      )}
    </div>
  )
}

// ─── Agents view ──────────────────────────────────────────────────────────────
function AgentsView({ teamId }: { teamId: string }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [name, setName] = useState('')
  const [command, setCommand] = useState('claude --dangerously-skip-permissions')
  const [workDir, setWorkDir] = useState('~/projects')
  const [creating, setCreating] = useState(false)
  const [newToken, setNewToken] = useState<{ agentId: string; token: string } | null>(null)
  const [tokenLabel, setTokenLabel] = useState('')

  const load = useCallback(async () => {
    const d = await api.agents.list(teamId)
    setAgents(d.agents ?? [])
  }, [teamId])

  useEffect(() => { load() }, [load])

  async function createAgent(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    try {
      await api.agents.create(teamId, { name, command, work_dir: workDir })
      setName(''); load()
    } finally { setCreating(false) }
  }

  async function genToken(agentId: string) {
    const label = tokenLabel || 'My Machine'
    const d = await api.agents.createToken(teamId, label)
    setNewToken({ agentId, token: d.token })
  }

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>Agents</h2>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 32 }}>
        {agents.length === 0 && <p style={{ color: '#aaa' }}>No agents yet.</p>}
        {agents.map(a => (
          <div key={a.id} style={{ background: '#fff', border: '1px solid #eee', borderRadius: 8, padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 500 }}>{a.name}</div>
              <div style={{ color: '#888', fontSize: 12 }}>{a.command} · {a.work_dir}</div>
              {a.last_seen && <div style={{ color: '#aaa', fontSize: 11, marginTop: 2 }}>Last seen {relativeTime(a.last_seen)}</div>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <StatusPill status={a.status} />
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={tokenLabel} onChange={e => setTokenLabel(e.target.value)} placeholder="Token label" style={{ padding: '5px 8px', border: '1px solid #ddd', borderRadius: 5, fontSize: 12, width: 100 }} />
                <button onClick={() => genToken(a.id)} style={{ padding: '5px 10px', background: '#eee', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 12 }}>
                  Gen token
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {newToken && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: 16, marginBottom: 24 }}>
          <strong>Token generated — copy now, shown once:</strong>
          <div style={{ fontFamily: 'monospace', fontSize: 13, marginTop: 8, wordBreak: 'break-all' }}>{newToken.token}</div>
          <button onClick={() => { navigator.clipboard.writeText(newToken.token); setNewToken(null) }} style={{ marginTop: 8, padding: '6px 12px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 12 }}>
            Copy &amp; dismiss
          </button>
        </div>
      )}

      <h3 style={{ marginBottom: 16 }}>Add agent</h3>
      <form onSubmit={createAgent} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Name (e.g. build-server-01)" required style={{ padding: '8px 10px', border: '1px solid #ddd', borderRadius: 6, fontSize: 14 }} />
        <input value={command} onChange={e => setCommand(e.target.value)} placeholder="Command" required style={{ padding: '8px 10px', border: '1px solid #ddd', borderRadius: 6, fontSize: 14 }} />
        <input value={workDir} onChange={e => setWorkDir(e.target.value)} placeholder="Work dir" required style={{ padding: '8px 10px', border: '1px solid #ddd', borderRadius: 6, fontSize: 14 }} />
        <button type="submit" disabled={creating} style={{ padding: '9px', background: '#111', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', alignSelf: 'flex-start', padding: '9px 20px' }}>
          {creating ? '…' : 'Create agent'}
        </button>
      </form>
    </div>
  )
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function SettingsView({ teamId, teamName }: { teamId: string; teamName: string }) {
  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>Settings</h2>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Team name</div>
        <div style={{ fontSize: 16, fontWeight: 500 }}>{teamName}</div>
        <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>ID: {teamId}</div>
      </div>
    </div>
  )
}

// ─── Create team gate ─────────────────────────────────────────────────────────
function CreateTeam({ onCreated }: { onCreated: (name: string) => void }) {
  const [name, setName] = useState('')
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui' }}>
      <form onSubmit={e => { e.preventDefault(); onCreated(name) }} style={{ width: 340, background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: 40 }}>
        <h2 style={{ margin: '0 0 24px' }}>Create your first team</h2>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Team name" required style={{ display: 'block', width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 6, fontSize: 14, marginBottom: 16, boxSizing: 'border-box' }} />
        <button type="submit" style={{ width: '100%', padding: 12, background: '#111', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, cursor: 'pointer' }}>
          Create team
        </button>
      </form>
    </div>
  )
}

// ─── Dashboard shell ──────────────────────────────────────────────────────────
export default function Dashboard() {
  const { teamId, teamName, createTeam } = useTeam()
  const [view, setView] = useState<'inbox' | 'agents' | 'settings'>('inbox')
  const nav = useNavigate()

  if (!teamId) return <CreateTeam onCreated={createTeam} />

  return (
    <div style={S.layout}>
      <aside style={S.sidebar}>
        <div style={S.logo}>TaskSquad</div>
        <button style={{ ...S.navBtn, fontWeight: view === 'inbox' ? 600 : 400 }} onClick={() => { setView('inbox'); nav('/dashboard') }}>Inbox</button>
        <button style={{ ...S.navBtn, fontWeight: view === 'agents' ? 600 : 400 }} onClick={() => { setView('agents'); nav('/dashboard/agents') }}>Agents</button>
        <button style={{ ...S.navBtn, fontWeight: view === 'settings' ? 600 : 400 }} onClick={() => { setView('settings'); nav('/dashboard/settings') }}>Settings</button>
        <div style={{ flex: 1 }} />
        <button onClick={() => signOut(auth)} style={{ ...S.navBtn, color: '#888' }}>Sign out</button>
      </aside>
      <main style={S.main}>
        <Routes>
          <Route path="/" element={<Inbox teamId={teamId} />} />
          <Route path="/tasks/:taskId" element={<TaskThread />} />
          <Route path="/agents" element={<AgentsView teamId={teamId} />} />
          <Route path="/settings" element={<SettingsView teamId={teamId} teamName={teamName} />} />
        </Routes>
      </main>
    </div>
  )
}

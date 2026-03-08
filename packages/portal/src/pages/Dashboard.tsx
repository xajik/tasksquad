import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { signOut } from 'firebase/auth'
import { Routes, Route, useNavigate, useParams, useLocation } from 'react-router-dom'
import { auth, getToken } from '../lib/firebase'
import { api, type Agent, type Task, type Message, type Team } from '../lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Inbox,
  Settings,
  Bot,
  LogOut,
  Trash2,
  Copy,
  ChevronDown,
  ChevronUp,
  Play,
  Loader2,
  FileText,
} from 'lucide-react'

// ── Transcript viewer ─────────────────────────────────────────────────────────

interface TranscriptEntry {
  type: string
  message?: {
    role?: string
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>
  }
  result?: string
  total_cost_usd?: number
}

function TranscriptViewer({ content }: { content: string }) {
  const entries: TranscriptEntry[] = content
    .trim()
    .split('\n')
    .flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })

  return (
    <div className="space-y-3 text-sm">
      {entries.map((entry, i) => {
        if (entry.type === 'user') {
          const text = entry.message?.content?.find(c => c.type === 'text')?.text
          if (!text) return null
          return (
            <div key={i} className="flex gap-2">
              <span className="font-semibold text-blue-600 shrink-0">Human</span>
              <span className="whitespace-pre-wrap">{text}</span>
            </div>
          )
        }
        if (entry.type === 'assistant') {
          return (entry.message?.content ?? []).map((c, j) => {
            if (c.type === 'text' && c.text) return (
              <div key={`${i}-${j}`} className="flex gap-2">
                <span className="font-semibold text-green-700 shrink-0">Claude</span>
                <span className="whitespace-pre-wrap">{c.text}</span>
              </div>
            )
            if (c.type === 'tool_use') return (
              <div key={`${i}-${j}`} className="flex gap-2 text-muted-foreground">
                <span className="font-semibold shrink-0">Tool</span>
                <span className="font-mono">{c.name}</span>
              </div>
            )
            return null
          })
        }
        if (entry.type === 'result' && entry.total_cost_usd != null) {
          return (
            <div key={i} className="text-xs text-muted-foreground border-t pt-2 mt-2">
              Cost: ${entry.total_cost_usd.toFixed(4)} · {entry.result}
            </div>
          )
        }
        return null
      })}
    </div>
  )
}

function TranscriptButton({ taskId, msgId }: { taskId: string; msgId: string }) {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleOpen() {
    setOpen(true)
    if (content !== null) return
    setLoading(true)
    try {
      const text = await api.messages.transcript(taskId, msgId)
      setContent(text)
    } catch {
      setContent('Failed to load transcript.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button
        onClick={handleOpen}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1 transition-colors"
      >
        <FileText className="h-3 w-3" />
        View transcript
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>CLI Transcript</DialogTitle>
            <DialogDescription>Full conversation from Claude Code</DialogDescription>
          </DialogHeader>
          <ScrollArea className="flex-1 mt-2">
            <div className="pr-4 font-mono text-xs">
              {loading && <p className="text-muted-foreground">Loading…</p>}
              {content && <TranscriptViewer content={content} />}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

const STATUS_COLOR: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: 'outline', queued: 'secondary', running: 'default', waiting_input: 'secondary',
  done: 'default', failed: 'destructive', offline: 'outline', idle: 'default',
  accumulating: 'default', live: 'default', stuck: 'secondary', error: 'destructive',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={STATUS_COLOR[status] ?? 'outline'}>
      {status}
    </Badge>
  )
}

function useTeam() {
  const [teamId, setTeamId] = useState<string | null>(null)
  const [teamName, setTeamName] = useState('')
  const [teams, setTeams] = useState<Team[]>([])
  const [isLoadingTeams, setIsLoadingTeams] = useState(true)

  useEffect(() => {
    async function loadTeams() {
      try {
        const storedTeamId = localStorage.getItem('tsq_team_id')
        
        const data = await api.teams.list()
        const uniqueTeams = Array.from(
          new Map(data.teams?.map(t => [t.id, t])).values()
        )
        setTeams(uniqueTeams)

        if (storedTeamId) {
          const storedTeam = data.teams.find(t => t.id === storedTeamId)
          if (storedTeam) {
            setTeamId(storedTeam.id)
            setTeamName(storedTeam.name)
          } else if (data.teams.length > 0) {
            const firstTeam = data.teams[0]
            setTeamId(firstTeam.id)
            setTeamName(firstTeam.name)
            localStorage.setItem('tsq_team_id', firstTeam.id)
            localStorage.setItem('tsq_team_name', firstTeam.name)
          }
        } else if (data.teams.length > 0) {
          const firstTeam = data.teams[0]
          setTeamId(firstTeam.id)
          setTeamName(firstTeam.name)
          localStorage.setItem('tsq_team_id', firstTeam.id)
          localStorage.setItem('tsq_team_name', firstTeam.name)
        }
      } catch (e) {
        console.error('Failed to load teams:', e)
      } finally {
        setIsLoadingTeams(false)
      }
    }
    loadTeams()
  }, [])

  async function createTeam(name: string) {
    const t = await api.teams.create(name)
    localStorage.setItem('tsq_team_id', t.id)
    localStorage.setItem('tsq_team_name', t.name)
    setTeamId(t.id)
    setTeamName(t.name)
    const data = await api.teams.list()
    setTeams(data.teams ?? [])
  }

  function switchTeam(team: Team) {
    setTeamId(team.id)
    setTeamName(team.name)
    localStorage.setItem('tsq_team_id', team.id)
    localStorage.setItem('tsq_team_name', team.name)
    window.location.reload()
  }

  return { teamId, teamName, teams, isLoadingTeams, createTeam, switchTeam }
}

function InboxView({ teamId }: { teamId: string }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [showCompose, setShowCompose] = useState(false)
  const [subject, setSubject] = useState('')
  const [taskBody, setTaskBody] = useState('')
  const [agentId, setAgentId] = useState('')
  const [creating, setCreating] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const nav = useNavigate()

  const load = useCallback(async () => {
    setIsLoading(true)
    const [td, ad] = await Promise.all([api.tasks.list(teamId), api.agents.list(teamId)])
    setTasks(td.tasks ?? [])
    setAgents(ad.agents ?? [])
    setIsLoading(false)
  }, [teamId])

  useEffect(() => { load() }, [load])

  async function compose(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    try {
      await api.tasks.create({ agent_id: agentId, subject, team_id: teamId, body: taskBody || undefined })
      setShowCompose(false); setSubject(''); setTaskBody(''); setAgentId('')
      load()
    } finally { setCreating(false) }
  }

  async function handleDeleteTask(taskId: string) {
    await api.tasks.delete(taskId)
    load()
  }

  const agentMap = useMemo(() => Object.fromEntries(agents.map(a => [a.id, a])), [agents])

  function taskStatus(t: Task): string {
    if (t.status === 'pending') {
      const agent = agentMap[t.agent_id]
      if (agent && (agent.status === 'running' || agent.status === 'waiting_input')) return 'queued'
    }
    return t.status
  }

  return (
    <div className="animate-fade-in">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-semibold">Inbox</h2>
        <Button onClick={() => setShowCompose(true)}>
          New message
        </Button>
      </div>

      <Dialog open={showCompose} onOpenChange={setShowCompose}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>New message</DialogTitle>
            <DialogDescription>
              Send a task to an agent.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={compose}>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="agent">Agent</Label>
                <Select value={agentId} onValueChange={setAgentId} required>
                  <SelectTrigger>
                    <SelectValue placeholder="Select agent…" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map(a => (
                      <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="subject">Subject</Label>
                <Input
                  id="subject"
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  placeholder="Task subject"
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="body">Description</Label>
                <Textarea
                  id="body"
                  value={taskBody}
                  onChange={e => setTaskBody(e.target.value)}
                  placeholder="Task description (optional — give Claude full context here)"
                  rows={5}
                  className="font-mono text-sm"
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCompose(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? '...' : 'Send'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-2">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-4">
                  <div className="h-4 bg-muted rounded w-1/3 mb-2"></div>
                  <div className="h-3 bg-muted rounded w-1/4"></div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <p className="text-muted-foreground">No messages yet.</p>
        ) : (
          tasks.map(t => (
            <Card
              key={t.id}
              className="cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => nav(`/dashboard/tasks/${t.id}`)}
            >
              <CardContent className="p-4 flex justify-between items-center">
                <div>
                  <div className="font-medium">{t.subject}</div>
                  <div className="text-sm text-muted-foreground">{agentMap[t.agent_id]?.name ?? t.agent_id}</div>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={taskStatus(t)} />
                  <span className="text-muted-foreground text-sm">{relativeTime(t.created_at)}</span>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={e => e.stopPropagation()}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete task</AlertDialogTitle>
                        <AlertDialogDescription>
                          Are you sure you want to delete "{t.subject}"? This will also delete all messages in this thread. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel onClick={e => e.stopPropagation()}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={e => { e.stopPropagation(); handleDeleteTask(t.id) }}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}

function TaskThread() {
  const { taskId } = useParams<{ taskId: string }>()
  const [task, setTask] = useState<Task | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [liveLines, setLiveLines] = useState<string[]>([])
  const [watching, setWatching] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)
  const nav = useNavigate()

  const load = useCallback(async () => {
    if (!taskId) return
    const [t, m] = await Promise.all([api.tasks.get(taskId), api.messages.list(taskId)])
    setTask(t)
    setMessages(m.messages ?? [])
  }, [taskId])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (watching) setShowLog(true) }, [watching])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, liveLines])

  // Auto-poll while the task is active so messages appear without manual refresh
  useEffect(() => {
    if (!task || watching) return
    if (!['running', 'waiting_input', 'pending'].includes(task.status)) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [task?.status, watching, load])

  async function startLive() {
    if (!task || esRef.current) return
    const token = await getToken()
    const es = new EventSource(`${import.meta.env.VITE_API_BASE_URL}/live/${task.agent_id}?token=${token}`)
    esRef.current = es
    setWatching(true)
    setLiveLines([])
    es.onmessage = (e) => {
      if (e.data.startsWith(':')) return
      const data = JSON.parse(e.data) as { type: string; text: string }
      if (data.type === 'connected') return
      if (data.type === 'line') setLiveLines(prev => [...prev, data.text])
      if (data.type === 'backlog') setLiveLines(data.text.split('\n'))
      if (data.type === 'done' || data.type === 'waiting_input') { es.close(); esRef.current = null; setWatching(false); load() }
    }
    es.onerror = () => { es.close(); esRef.current = null; setWatching(false) }
  }

  useEffect(() => () => { esRef.current?.close() }, [])

  async function deleteTask() {
    if (!taskId || !confirm('Delete this task and all its messages?')) return
    await api.tasks.delete(taskId)
    nav('/dashboard')
  }

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

  function roleStyle(role: string) {
    if (role === 'user') return 'bg-blue-50 rounded-lg p-3 self-end max-w-[70%]'
    if (role === 'agent') return 'bg-muted rounded-lg p-3 font-mono whitespace-pre-wrap max-w-[90%]'
    return 'text-muted-foreground text-xs italic py-1'
  }

  return (
    <div className="max-w-3xl animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <h2 className="text-2xl font-semibold flex-1">{task?.subject ?? '...'}</h2>
        {task && <StatusBadge status={task.status} />}
        {task && (task.status === 'running') && !watching && (
          <Button onClick={startLive} size="sm">
            <Play className="h-4 w-4 mr-1" />
            Watch live
          </Button>
        )}
        {watching && (
          <Button variant="secondary" size="sm" disabled>
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            Live
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={deleteTask}>
          <Trash2 className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>

      <ScrollArea className="h-[500px] mb-6">
        <div className="flex flex-col gap-2 pr-4">
          {messages.map(m => (
            <div key={m.id}>
              <div className={roleStyle(m.role)}>{m.body}</div>
              {m.role === 'agent' && m.transcript_key && taskId && (
                <TranscriptButton taskId={taskId} msgId={m.id} />
              )}
            </div>
          ))}
          {liveLines.length > 0 && (
            <div className="border rounded-lg overflow-hidden">
              <button
                onClick={() => setShowLog(x => !x)}
                className="w-full text-left px-3 py-2 bg-muted text-sm flex justify-between items-center hover:bg-muted/80"
              >
                <span>Session log ({liveLines.length} lines){watching ? ' · live' : ''}</span>
                {showLog ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              {showLog && (
                <div className="bg-zinc-900 text-green-400 p-3 font-mono text-xs whitespace-pre-wrap max-h-80 overflow-auto">
                  {liveLines.join('\n')}
                </div>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {task && ['waiting_input', 'done', 'failed'].includes(task.status) && (
        <form onSubmit={sendReply} className="flex gap-2">
          <Input
            value={reply} onChange={e => setReply(e.target.value)}
            placeholder={task.status === 'waiting_input' ? 'Reply to agent…' : 'Follow up…'}
            className="flex-1"
          />
          <Button type="submit" disabled={sending}>
            {sending ? '...' : 'Send'}
          </Button>
        </form>
      )}
    </div>
  )
}

function AgentsView({ teamId }: { teamId: string }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [name, setName] = useState('')
  const [command, setCommand] = useState('claude --dangerously-skip-permissions')
  const [workDir, setWorkDir] = useState('~/projects')
  const [creating, setCreating] = useState(false)
  const [newToken, setNewToken] = useState<{ agentId: string; token: string } | null>(null)
  const [tokenLabel, setTokenLabel] = useState('')
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async () => {
    setIsLoading(true)
    const d = await api.agents.list(teamId)
    setAgents(d.agents ?? [])
    setIsLoading(false)
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
    const d = await api.agents.createToken(teamId, agentId, label)
    setNewToken({ agentId, token: d.token })
  }

  async function deleteAgent(agentId: string) {
    await api.agents.delete(teamId, agentId)
    load()
  }

  return (
    <div className="animate-fade-in">
      <h2 className="text-2xl font-semibold mb-6">Agents</h2>

      <div className="flex flex-col gap-3 mb-8">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2].map(i => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-4">
                  <div className="h-4 bg-muted rounded w-1/4 mb-2"></div>
                  <div className="h-3 bg-muted rounded w-1/2"></div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : agents.length === 0 ? (
          <p className="text-muted-foreground">No agents yet.</p>
        ) : (
          agents.map(a => (
            <Card key={a.id}>
              <CardContent className="p-4 flex justify-between items-start">
                <div>
                  <div className="font-medium">{a.name}</div>
                  <div className="text-sm text-muted-foreground">{a.command} · {a.work_dir}</div>
                  <div className="text-xs text-muted-foreground font-mono mt-1">ID: {a.id}</div>
                  {a.last_seen && <div className="text-xs text-muted-foreground mt-1">Last seen {relativeTime(a.last_seen)}</div>}
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={a.status} />
                  <div className="flex gap-2">
                    <Input
                      value={tokenLabel}
                      onChange={e => setTokenLabel(e.target.value)}
                      placeholder="Token label"
                      className="h-8 w-28 text-xs"
                    />
                    <Button variant="secondary" size="sm" onClick={() => genToken(a.id)}>
                      Gen token
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete agent</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to delete "{a.name}"? This will also delete all tasks and messages associated with this agent. This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => deleteAgent(a.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {newToken && (() => {
        const snippet = `[server]
url = "https://tasksquad-api.xajik0.workers.dev"
poll_interval = 30

[hooks]
port = 7374

[[agents]]
token = "${newToken.token}"
name = "${name || 'my-agent'}"
command = "${command}"
work_dir = "${workDir}"`

        return (
          <Card className="border-green-500 bg-green-50 dark:bg-green-950 mb-6">
            <CardHeader>
              <CardTitle className="text-green-700 dark:text-green-400">Token generated</CardTitle>
              <CardDescription>Copy config now, shown once</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="bg-background border rounded-md p-3 text-xs font-mono whitespace-pre-wrap break-all">
                {snippet}
              </pre>
            </CardContent>
            <CardFooter className="gap-2">
              <Button onClick={() => { navigator.clipboard.writeText(snippet); setNewToken(null) }}>
                <Copy className="h-4 w-4 mr-1" />
                Copy config &amp; dismiss
              </Button>
              <Button variant="outline" onClick={() => setNewToken(null)}>
                Dismiss
              </Button>
            </CardFooter>
          </Card>
        )
      })()}

      <Separator className="my-6" />

      <h3 className="text-lg font-semibold mb-4">Add agent</h3>
      <form onSubmit={createAgent} className="grid gap-4 max-w-md">
        <div className="grid gap-2">
          <Label htmlFor="agent-name">Name</Label>
          <Input
            id="agent-name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. build-server-01"
            required
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="agent-command">Command</Label>
          <Input
            id="agent-command"
            value={command}
            onChange={e => setCommand(e.target.value)}
            placeholder="Command"
            required
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="agent-workdir">Work directory</Label>
          <Input
            id="agent-workdir"
            value={workDir}
            onChange={e => setWorkDir(e.target.value)}
            placeholder="Work dir"
            required
          />
        </div>
        <Button type="submit" disabled={creating} className="w-fit">
          {creating ? '...' : 'Create agent'}
        </Button>
      </form>
    </div>
  )
}

function SettingsView({ teamId, teamName }: { teamId: string; teamName: string }) {
  return (
    <div className="animate-fade-in">
      <h2 className="text-2xl font-semibold mb-6">Settings</h2>
      <div className="max-w-md">
        <div className="text-sm text-muted-foreground mb-1">Team name</div>
        <div className="font-medium mb-4">{teamName}</div>

        <div className="text-sm text-muted-foreground mb-1">Team ID</div>
        <div className="flex items-center gap-2">
          <code className="flex-1 bg-muted px-3 py-2 rounded-md text-sm font-mono break-all">{teamId}</code>
          <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(teamId)}>
            <Copy className="h-4 w-4" />
          </Button>
        </div>
        <div className="text-xs text-muted-foreground mt-1">Used in daemon config and API calls</div>
      </div>
    </div>
  )
}

function CreateTeam({ onCreated }: { onCreated: (name: string) => void }) {
  const [name, setName] = useState('')
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Card className="w-[340px]">
        <CardHeader>
          <CardTitle>Create your first team</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={e => { e.preventDefault(); onCreated(name) }}>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="team-name">Team name</Label>
                <Input
                  id="team-name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="My Team"
                  required
                />
              </div>
              <Button type="submit">Create team</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

export default function Dashboard() {
  const { teamId, teamName, teams, isLoadingTeams, createTeam, switchTeam } = useTeam()
  const location = useLocation()
  const nav = useNavigate()

  const isAgents = location.pathname === '/dashboard/agents'
  const isSettings = location.pathname === '/dashboard/settings'

  if (!teamId) return <CreateTeam onCreated={createTeam} />

  return (
    <div className="flex h-screen">
      <aside className="w-52 border-r bg-background flex flex-col">
        <div className="font-bold text-lg px-4 py-5">TaskSquad</div>
        <nav className="flex-1 px-2">
          <Button
            variant={!isAgents && !isSettings ? 'secondary' : 'ghost'}
            className="w-full justify-start mb-1"
            onClick={() => nav('/dashboard')}
          >
            <Inbox className="mr-2 h-4 w-4" />
            Inbox
          </Button>
          <Button
            variant={isAgents ? 'secondary' : 'ghost'}
            className="w-full justify-start mb-1"
            onClick={() => nav('/dashboard/agents')}
          >
            <Bot className="mr-2 h-4 w-4" />
            Agents
          </Button>
          <Button
            variant={isSettings ? 'secondary' : 'ghost'}
            className="w-full justify-start"
            onClick={() => nav('/dashboard/settings')}
          >
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </Button>
        </nav>
        <div className="p-2 border-t">
          {isLoadingTeams ? (
            <div className="px-2 py-2 text-sm text-muted-foreground">Loading...</div>
          ) : (
            <Select
              value={teamId}
              onValueChange={(value) => {
                const team = teams.find(t => t.id === value)
                if (team) switchTeam(team)
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select team" />
              </SelectTrigger>
              <SelectContent>
                {teams.map(team => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
                <SelectItem value="__create__" disabled className="text-muted-foreground">
                  + Create new team (coming soon)
                </SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="p-2">
          <Button variant="ghost" className="w-full justify-start text-muted-foreground" onClick={() => signOut(auth)}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-8">
        <Routes>
          <Route path="/" element={<InboxView teamId={teamId} />} />
          <Route path="/tasks/:taskId" element={<TaskThread />} />
          <Route path="/agents" element={<AgentsView teamId={teamId} />} />
          <Route path="/settings" element={<SettingsView teamId={teamId} teamName={teamName} />} />
        </Routes>
      </main>
    </div>
  )
}

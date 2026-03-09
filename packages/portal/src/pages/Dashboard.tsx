import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { signOut } from 'firebase/auth'
import { Routes, Route, useNavigate, useParams, useLocation } from 'react-router-dom'
import { auth, getToken } from '../lib/firebase'
import { api, type Agent, type Task, type Message, type Team } from '../lib/api'
import { cn } from '@/lib/utils'
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
  DialogTrigger,
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
  User,
  LogOut,
  Trash2,
  Copy,
  ChevronDown,
  ChevronUp,
  Play,
  Loader2,
  FileText,
  Code2,
  Terminal,
  ExternalLink,
  CheckCircle,
  Plus,
  Menu,
  X,
  Key,
} from 'lucide-react'

// ── Transcript viewer ─────────────────────────────────────────────────────────

interface TranscriptEntry {
  type: string
  message?: {
    role?: string
    content?: string | Array<{
      type: string
      text?: string
      name?: string
      input?: any
      tool_use_id?: string
      content?: string
    }>
  }
  tool_use_id?: string
  output?: string
  content?: string
  result?: string
  total_cost_usd?: number
}

function ToolExecution({ name, input, output }: { name: string; input: any; output?: string }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border border-border/60 rounded-lg overflow-hidden my-2 bg-muted/20">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/40 transition-colors text-xs font-medium"
      >
        <Terminal className="h-3 w-3 text-muted-foreground" />
        <span className="text-muted-foreground italic">use tool</span>
        <span className="font-mono text-foreground">{name}</span>
        <div className="flex-1" />
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {expanded && (
        <div className="p-3 pt-0 space-y-3">
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
              <Code2 className="h-2.5 w-2.5" /> Input
            </div>
            <pre className="text-[11px] bg-zinc-950 text-emerald-400/90 p-2 rounded border border-white/5 overflow-auto max-h-40">
              {typeof input === 'string' ? input : JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {output && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
                <ExternalLink className="h-2.5 w-2.5" /> Output
              </div>
              <pre className="text-[11px] bg-zinc-900 text-zinc-300 p-2 rounded border border-white/5 overflow-auto max-h-60">
                {output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TranscriptViewer({ content }: { content: string }) {
  // Plain-text mode: tmux capture-pane output (not JSONL).
  // Detect by checking whether the first non-empty line parses as JSON.
  const isJsonl = useMemo(() => {
    const firstLine = content.trim().split('\n').find(l => l.trim())
    if (!firstLine) return false
    try { JSON.parse(firstLine); return true } catch { return false }
  }, [content])

  const entries: TranscriptEntry[] = useMemo(() => {
    if (!isJsonl) return []
    return content
      .trim()
      .split('\n')
      .flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  }, [content, isJsonl])

  // Link outputs back to tool uses
  const toolOutputs = useMemo(() => {
    const outputs: Record<string, string> = {}
    entries.forEach(e => {
      if (e.type === 'tool_result' && e.tool_use_id && e.content) {
        outputs[e.tool_use_id] = e.content
      }
    })
    return outputs
  }, [entries])

  if (!isJsonl) {
    return (
      <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap text-foreground/90 bg-muted/20 rounded-lg p-4 border border-border/40 overflow-x-auto">
        {content}
      </pre>
    )
  }

  return (
    <div className="space-y-6 pb-4">
      {entries.map((entry, i) => {
        if (entry.type === 'user') {
          const raw = entry.message?.content
          const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.find(c => c.type === 'text')?.text : undefined
          if (!text) return null
          return (
            <div key={i} className="space-y-1">
              <div className="text-[10px] uppercase tracking-widest font-bold text-blue-500/80">Human</div>
              <div className="text-sm leading-relaxed whitespace-pre-wrap pl-3 border-l-2 border-blue-500/20">{text}</div>
            </div>
          )
        }

        if (entry.type === 'assistant') {
          return (
            <div key={i} className="space-y-3">
              <div className="text-[10px] uppercase tracking-widest font-bold text-emerald-600/80">Claude</div>
              <div className="space-y-2 pl-3 border-l-2 border-emerald-500/20">
                {Array.isArray(entry.message?.content) && entry.message.content.map((c, j) => {
                  if (c.type === 'text' && c.text) {
                    return <div key={j} className="text-sm leading-relaxed whitespace-pre-wrap">{c.text}</div>
                  }
                  if (c.type === 'tool_use' && c.name && c.input && c.tool_use_id) {
                    return (
                      <ToolExecution
                        key={j}
                        name={c.name}
                        input={c.input}
                        output={toolOutputs[c.tool_use_id]}
                      />
                    )
                  }
                  return null
                })}
              </div>
            </div>
          )
        }

        if (entry.type === 'result' && entry.total_cost_usd != null) {
          return (
            <div key={i} className="bg-muted/30 rounded-lg p-3 border border-border/40 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-muted-foreground uppercase tracking-tight">Outcome:</span>
                <span className="font-medium text-foreground capitalize">{entry.result}</span>
              </div>
              <div className="text-muted-foreground font-mono">
                ${entry.total_cost_usd.toFixed(4)}
              </div>
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
        className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-primary mt-3 py-1.5 px-3 rounded-md bg-muted/30 border border-border/50 transition-all hover:bg-muted/50"
      >
        <FileText className="h-3 w-3" />
        CLI Transcript
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl w-[90vw] max-h-[90vh] flex flex-col p-0 overflow-hidden border-none shadow-2xl">
          <div className="bg-muted/30 px-6 py-4 border-b border-border flex items-center justify-between">
            <div>
              <DialogTitle className="text-lg font-bold">Execution Transcript</DialogTitle>
              <DialogDescription className="text-xs">Detailed step-by-step logs CLI</DialogDescription>
            </div>
          </div>
          <ScrollArea className="flex-1 bg-background">
            <div className="p-8">
              {loading && (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                  <Loader2 className="h-8 w-8 animate-spin text-primary/50" />
                  <p className="text-sm text-muted-foreground animate-pulse">Retrieving transcript...</p>
                </div>
              )}
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
              <CardContent className="p-3 sm:p-4 flex items-center gap-2 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{t.subject}</div>
                  <div className="text-sm text-muted-foreground truncate">{agentMap[t.agent_id]?.name ?? t.agent_id}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusBadge status={taskStatus(t)} />
                  <span className="text-muted-foreground text-sm hidden sm:inline">{relativeTime(t.created_at)}</span>
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

function MessageBubble({ message, agentName, taskId }: { message: Message; agentName?: string; taskId?: string }) {
  const isUser = message.role === 'user'
  const isAgent = message.role === 'agent'
  const isSystem = message.role === 'system'

  if (isSystem) {
    return (
      <div className="flex justify-center my-4">
        <div className="bg-muted/50 text-muted-foreground text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded-full border border-border/50">
          {message.body}
        </div>
      </div>
    )
  }

  const time = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} mb-6 group`}>
      <div className={`flex items-center gap-2 mb-1 px-1 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
        <div className={`w-6 h-6 rounded-full flex items-center justify-center ${isUser ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'} shrink-0`}>
          {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
        </div>
        <span className="text-xs font-semibold text-foreground/70">
          {isUser ? 'You' : (agentName || 'Agent')}
        </span>
        <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
          {time}
        </span>
      </div>

      <div className={`
        relative px-4 py-3 rounded-2xl max-w-[85%] shadow-sm transition-all break-words
        ${isUser
          ? 'bg-primary text-primary-foreground rounded-tr-none shadow-md'
          : 'bg-card border border-border text-card-foreground rounded-tl-none font-mono whitespace-pre-wrap'
        }
      `}>
        <div className="text-[14px] leading-relaxed select-text">{message.body}</div>

        <div className={`
          text-[10px] mt-1.5 flex justify-end font-medium
          ${isUser ? 'text-primary-foreground/80' : 'text-muted-foreground/80'}
        `}>
          {time}
        </div>

        {isAgent && message.transcript_key && taskId && (
          <div className="mt-3 pt-2 border-t border-border/10">
            <TranscriptButton taskId={taskId} msgId={message.id} />
          </div>
        )}
      </div>
    </div>
  )
}

function TaskThread({ teamId }: { teamId: string }) {
  const { taskId } = useParams<{ taskId: string }>()
  const [task, setTask] = useState<Task | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
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
    const [t, m, ad] = await Promise.all([
      api.tasks.get(taskId),
      api.messages.list(taskId),
      api.agents.list(teamId)
    ])
    setTask(t)
    setMessages(m.messages ?? [])
    setAgents(ad.agents ?? [])
  }, [taskId, teamId])

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

  async function closeTask() {
    if (!taskId) return
    await api.tasks.close(taskId)
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

  const agentName = useMemo(() => {
    if (!task) return 'Agent'
    return agents.find(a => a.id === task.agent_id)?.name || 'Agent'
  }, [task, agents])

  return (
    <div className="max-w-3xl animate-fade-in mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6 sm:mb-8 pb-4 border-b border-border/50">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight">{task?.subject ?? '...'}</h2>
            {task && <StatusBadge status={task.status} />}
          </div>
          <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <Bot className="h-3.5 w-3.5" />
              {agentName}
            </span>
            <span>·</span>
            <span>Started {task ? relativeTime(task.created_at) : '...'}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {task && (task.status === 'running') && !watching && (
            <Button onClick={startLive} size="sm" className="rounded-full">
              <Play className="h-4 w-4 mr-1" />
              Watch live
            </Button>
          )}
          {watching && (
            <Button variant="secondary" size="sm" disabled className="rounded-full">
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              Live
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={deleteTask} className="rounded-full hover:bg-destructive/10 hover:text-destructive">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="bg-background/50 rounded-xl border border-border/40 overflow-hidden shadow-sm">
        <ScrollArea className="h-[50vh] sm:h-[600px] p-4 sm:p-6">
          <div className="flex flex-col pr-4">
            {messages.map(m => (
              <MessageBubble
                key={m.id}
                message={m}
                agentName={agentName}
                taskId={taskId}
              />
            ))}
            {liveLines.length > 0 && (
              <div className="mt-4 border rounded-xl overflow-hidden shadow-md">
                <button
                  onClick={() => setShowLog(x => !x)}
                  className="w-full text-left px-4 py-3 bg-zinc-900 text-zinc-100 text-sm flex justify-between items-center hover:bg-zinc-800 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${watching ? 'bg-green-500 animate-pulse' : 'bg-zinc-500'}`} />
                    <span className="font-medium">Session log ({liveLines.length} lines)</span>
                  </div>
                  {showLog ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                {showLog && (
                  <div className="bg-zinc-950 text-emerald-400 p-4 font-mono text-xs whitespace-pre-wrap max-h-96 overflow-auto scrollbar-thin scrollbar-thumb-zinc-800">
                    {liveLines.join('\n')}
                  </div>
                )}
              </div>
            )}
            <div ref={bottomRef} className="h-4" />
          </div>
        </ScrollArea>

        {task && task.status === 'waiting_input' && (
          <div className="p-4 bg-muted/20 border-t border-border/40">
            <form onSubmit={sendReply} className="flex gap-2">
              <Input
                value={reply} onChange={e => setReply(e.target.value)}
                placeholder="Reply to agent…"
                className="flex-1 bg-background border-border/60 focus:ring-primary rounded-full px-5"
              />
              <Button type="submit" disabled={sending} className="rounded-full px-6">
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send'}
              </Button>
            </form>
          </div>
        )}
      </div>

      {task && !['done', 'failed'].includes(task.status) && (
        <div className="mt-4 flex justify-center">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-emerald-600 transition-colors">
                <CheckCircle className="h-4 w-4 mr-1.5" />
                Close Session
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Close Session?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will mark the task as done. You can always follow up later if needed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep open</AlertDialogCancel>
                <AlertDialogAction onClick={closeTask} className="bg-emerald-600 hover:bg-emerald-700">
                  Close Session
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </div>
  )
}

function AgentsView({ teamId }: { teamId: string }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [newToken, setNewToken] = useState<{ agentId: string; token: string; agentName: string } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'claude' | 'gemini'>('claude')

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
      // Default values are now handled by the UI guide
      await api.agents.create(teamId, { name, command: 'claude --dangerously-skip-permissions', work_dir: '~/Projects' })
      setName(''); load()
    } finally { setCreating(false) }
  }

  async function genToken(agentId: string, agentName: string) {
    const d = await api.agents.createToken(teamId, agentId, 'Default')
    setNewToken({ agentId, token: d.token, agentName })
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
          <div className="py-12 text-center border-2 border-dashed rounded-lg bg-muted/30">
            <Bot className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-muted-foreground">No agents yet. Create one to get started.</p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {agents.map(a => (
              <Card key={a.id} className="group overflow-hidden border-2 hover:border-primary/50 transition-all">
                <CardHeader className="p-4 pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={cn("h-2 w-2 rounded-full", a.status === 'active' ? "bg-green-500 animate-pulse" : "bg-muted-foreground")} />
                      <CardTitle className="text-base font-medium">{a.name}</CardTitle>
                    </div>
                    <StatusBadge status={a.status} />
                  </div>
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  <div className="text-xs text-muted-foreground font-mono truncate mb-4">ID: {a.id}</div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex gap-2">
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="outline" size="sm">
                            <Key className="h-4 w-4 mr-1" />
                            Get Token
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Generate connection token</DialogTitle>
                            <DialogDescription>
                              This will generate a new token for {a.name}. Any existing token for this agent will remain valid, but only one can be used at a time.
                            </DialogDescription>
                          </DialogHeader>
                          <DialogFooter>
                            <DialogTrigger asChild>
                              <Button onClick={() => genToken(a.id, a.name)}>Generate Token</Button>
                            </DialogTrigger>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete agent?</AlertDialogTitle>
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
            ))}
          </div>
        )}
      </div>

      {newToken && (() => {
        const config = activeTab === 'claude' 
          ? { cmd: 'claude --dangerously-skip-permissions', dir: '~/Projects/my-tasksquad-project' }
          : { cmd: 'gemini --yolo', dir: '~/Projects/my-tasksquad-project' }
        
        const snippet = `[[agents]]
name     = "${newToken.agentName}"
token    = "${newToken.token}"
command  = "${config.cmd}"
work_dir = "${config.dir}"`

        return (
          <Card className="border-green-500 bg-green-50 dark:bg-green-950 mb-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-green-700 dark:text-green-400">Token generated</CardTitle>
                  <CardDescription>Add this to your ~/.tasksquad/config.toml</CardDescription>
                </div>
                <div className="flex bg-muted p-1 rounded-md text-sm">
                  <button 
                    onClick={() => setActiveTab('claude')}
                    className={cn(
                      "px-3 py-1 rounded-sm transition-colors",
                      activeTab === 'claude' ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Claude
                  </button>
                  <button 
                    onClick={() => setActiveTab('gemini')}
                    className={cn(
                      "px-3 py-1 rounded-sm transition-colors",
                      activeTab === 'gemini' ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Gemini
                  </button>
                </div>
              </div>
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
      <form onSubmit={createAgent} className="flex gap-2 max-w-md">
        <Input
          id="agent-name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Agent name (e.g. frontend-helper)"
          required
        />
        <Button type="submit" disabled={creating} className="w-fit">
          {creating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
          Create agent
        </Button>
      </form>
    </div>
  )
}

function SettingsView({ teamName, onDelete }: { teamName: string; onDelete: () => Promise<void> }) {
  const [confirmName, setConfirmName] = useState('')
  const [deleting, setDeleting] = useState(false)

  return (
    <div className="animate-fade-in">
      <h2 className="text-2xl font-semibold mb-6">Settings</h2>
      <div className="max-w-md space-y-8">
        <div>
          <div className="text-sm text-muted-foreground mb-1 font-medium">Project name</div>
          <div className="text-lg font-semibold">{teamName}</div>
        </div>

        

        <div className="space-y-4 pt-4 border-t border-destructive/20">
          <h3 className="text-lg font-semibold text-destructive flex items-center gap-2">
            <Trash2 className="h-5 w-5" />
            Delete this project
          </h3>
          <p className="text-sm text-muted-foreground">
            Once you delete a project, there is no going back. All active agent sessions will be killed and all pending chats will be closed.
          </p>
          
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" className="w-full sm:w-auto">
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="sm:max-w-[450px]">
              <AlertDialogHeader>
                <AlertDialogTitle className="text-destructive">Are you absolutely sure?</AlertDialogTitle>
                <AlertDialogDescription className="space-y-4">
                  <p>
                    This action will mark the project <span className="font-bold text-foreground">"{teamName}"</span> as deactivated. 
                    It will no longer be visible to you or your team members.
                  </p>
                  <div className="bg-destructive/10 p-3 rounded-md text-destructive text-xs space-y-1">
                    <p className="font-bold">Important consequences:</p>
                    <ul className="list-disc list-inside space-y-0.5">
                      <li>All running agent sessions will be terminated immediately.</li>
                      <li>All pending tasks will be marked as failed.</li>
                      <li>The project will be hidden from your dashboard.</li>
                    </ul>
                  </div>
                  <div className="space-y-2 mt-4">
                    <Label htmlFor="confirm-team-name space-y-2" className="text-foreground">
                      Type <span className="font-bold select-none">{teamName}</span> to confirm:
                    </Label>
                    <Input
                      id="confirm-team-name"
                      value={confirmName}
                      onChange={e => setConfirmName(e.target.value)}
                      placeholder={teamName}
                      className="border-destructive/30 focus-visible:ring-destructive"
                      autoComplete="off"
                    />
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setConfirmName('')}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={confirmName !== teamName || deleting}
                  onClick={async (e) => {
                    e.preventDefault()
                    setDeleting(true)
                    try {
                      await onDelete()
                    } catch (err) {
                      console.error('Failed to deactivate project:', err)
                      setDeleting(false)
                    }
                  }}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90 min-w-[100px]"
                >
                  {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Deactivate Project'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
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

const FREE_TEAM_LIMIT = 3

export default function Dashboard() {
  const { teamId, teamName, teams, isLoadingTeams, createTeam, switchTeam } = useTeam()
  const location = useLocation()
  const nav = useNavigate()

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showCreateTeam, setShowCreateTeam] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const [createTeamError, setCreateTeamError] = useState('')
  const [creatingTeam, setCreatingTeam] = useState(false)

  function handleNav(path: string) {
    nav(path)
    setSidebarOpen(false)
  }

  const isAgents = location.pathname === '/dashboard/agents'
  const isSettings = location.pathname === '/dashboard/settings'

  if (isLoadingTeams) return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  )

  if (!teamId) return <CreateTeam onCreated={createTeam} />

  async function handleCreateTeam(e: React.FormEvent) {
    e.preventDefault()
    if (teams.length >= FREE_TEAM_LIMIT) {
      setCreateTeamError(`Free plan allows up to ${FREE_TEAM_LIMIT} projects. Upgrade to Pro for unlimited projects.`)
      return
    }
    setCreatingTeam(true)
    try {
      await createTeam(newTeamName)
      setNewTeamName('')
      setShowCreateTeam(false)
      setCreateTeamError('')
    } finally {
      setCreatingTeam(false)
    }
  }

  async function handleDeleteProject() {
    if (!teamId) return
    await api.teams.delete(teamId)
    // Force reload to clear all states and re-fetch teams
    window.location.href = '/dashboard'
  }

  return (
    <div className="flex h-screen overflow-hidden relative">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={[
        'flex flex-col border-r bg-background shrink-0',
        'fixed inset-y-0 left-0 z-50 w-64',
        'md:relative md:z-auto md:w-52',
        'transition-transform duration-200 ease-in-out',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      ].join(' ')}>
        <div className="flex items-center gap-2 font-bold text-lg px-4 py-5">
          <img src="/tasksquad-dark.svg" alt="TaskSquad" className="h-5 w-5" />
          <span>TaskSquad</span>
          <button
            className="ml-auto rounded-md p-1 hover:bg-muted transition-colors md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex-1 px-2">
          <Button
            variant={!isAgents && !isSettings ? 'secondary' : 'ghost'}
            className="w-full justify-start mb-1"
            onClick={() => handleNav('/dashboard')}
          >
            <Inbox className="mr-2 h-4 w-4" />
            Inbox
          </Button>
          <Button
            variant={isAgents ? 'secondary' : 'ghost'}
            className="w-full justify-start mb-1"
            onClick={() => handleNav('/dashboard/agents')}
          >
            <Bot className="mr-2 h-4 w-4" />
            Agents
          </Button>
          <Button
            variant={isSettings ? 'secondary' : 'ghost'}
            className="w-full justify-start"
            onClick={() => handleNav('/dashboard/settings')}
          >
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </Button>
        </nav>
        <div className="p-2 border-t space-y-1">
          {isLoadingTeams ? (
            <div className="px-2 py-2 text-sm text-muted-foreground">Loading...</div>
          ) : (
            <>
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
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs text-muted-foreground"
                onClick={() => { setCreateTeamError(''); setShowCreateTeam(true) }}
              >
                <Plus className="mr-1.5 h-3 w-3" />
                New project
              </Button>
            </>
          )}
        </div>
        <div className="p-2">
          <Button variant="ghost" className="w-full justify-start text-muted-foreground" onClick={() => signOut(auth)}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b bg-background md:hidden shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="rounded-md p-1.5 hover:bg-muted transition-colors"
            aria-label="Open sidebar"
          >
            <Menu className="h-5 w-5" />
          </button>
          <img src="/tasksquad-dark.svg" alt="TaskSquad" className="h-5 w-5" />
          <span className="font-bold">TaskSquad</span>
        </div>
        <main className="flex-1 overflow-auto p-4 sm:p-8">
        <Routes>
          <Route path="/" element={<InboxView teamId={teamId} />} />
          <Route path="/tasks/:taskId" element={<TaskThread teamId={teamId} />} />
          <Route path="/agents" element={<AgentsView teamId={teamId} />} />
          <Route path="/settings" element={<SettingsView teamName={teamName} onDelete={handleDeleteProject} />} />
        </Routes>
      </main>
      </div>

      <Dialog open={showCreateTeam} onOpenChange={setShowCreateTeam}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>Create a new team project.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateTeam}>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="new-team-name">Project name</Label>
                <Input
                  id="new-team-name"
                  value={newTeamName}
                  onChange={e => setNewTeamName(e.target.value)}
                  placeholder="My project"
                  required
                  autoFocus
                />
              </div>
              {createTeamError && (
                <p className="text-sm text-destructive">{createTeamError}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreateTeam(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creatingTeam || teams.length >= FREE_TEAM_LIMIT}>
                {creatingTeam ? '...' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

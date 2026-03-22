import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { signOut } from 'firebase/auth'
import { Routes, Route, useNavigate, useParams, useLocation } from 'react-router-dom'
import { auth, getToken } from '../lib/firebase'
import { trackEvent } from '../lib/analytics'
import { api, type Agent, type Task, type Message, type Team, type Member } from '../lib/api'
import { requestNotificationPermission, notify, STATUS_NOTIF, registerPushToken } from '../lib/notifications'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { DateTimePicker } from '@/components/ui/date-time-picker'
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
  Users,
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
  ArrowLeft,
  Forward,
  RotateCcw,
  PauseCircle,
  PlayCircle,
  AlertTriangle,
  RefreshCw,
  Repeat,
  Check,
  Clock,
  Edit,
  Brain,
  Wrench,
  ChevronRight,
  ShieldAlert,
} from 'lucide-react'

import { Notes } from './Notes'
import { NoteDetail } from './NoteDetail'
import { Conveyors } from './Conveyors'

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
      <pre className="text-xs font-mono leading-relaxed whitespace-pre text-foreground/90 bg-muted/20 rounded-lg p-4 border border-border/40">
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
                    return <div key={j} className="text-sm leading-relaxed whitespace-pre">{c.text}</div>
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
    trackEvent('transcript_viewed', { taskId, msgId });
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
        <DialogContent className="max-w-4xl w-[90vw] h-[90vh] flex flex-col p-0 overflow-hidden border-none shadow-2xl">
          <div className="bg-muted/30 px-6 py-4 border-b border-border flex items-center justify-between">
            <div>
              <DialogTitle className="text-lg font-bold">Execution Transcript</DialogTitle>
              <DialogDescription className="text-xs">Detailed step-by-step logs CLI</DialogDescription>
            </div>
          </div>
          <ScrollArea className="flex-1 min-h-0 bg-background">
            <div className="p-4 sm:p-8">
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
  scheduled: 'secondary',
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
    trackEvent('team_created', { team_id: t.id, name: t.name });
    localStorage.setItem('tsq_team_id', t.id)
    localStorage.setItem('tsq_team_name', t.name)
    setTeamId(t.id)
    setTeamName(t.name)
    const data = await api.teams.list()
    setTeams(data.teams ?? [])
  }

  function switchTeam(team: Team) {
    trackEvent('team_switched', { team_id: team.id, team_name: team.name });
    setTeamId(team.id)
    setTeamName(team.name)
    localStorage.setItem('tsq_team_id', team.id)
    localStorage.setItem('tsq_team_name', team.name)
    window.location.reload()
  }

  return { teamId, teamName, teams, isLoadingTeams, createTeam, switchTeam }
}

function InboxView({ teamId, internalUserId }: { teamId: string; internalUserId: string | null }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [showCompose, setShowCompose] = useState(false)
  const [subject, setSubject] = useState('')
  const [taskBody, setTaskBody] = useState('')
  const [agentId, setAgentId] = useState('')
  const [creating, setCreating] = useState(false)
  const [showSchedulePicker, setShowSchedulePicker] = useState(false)
  const [scheduledDate, setScheduledDate] = useState<Date | undefined>(undefined)
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [activeFilter, setActiveFilter] = useState<'all' | 'system' | 'mine' | 'from-note' | 'scheduled'>('all')
  const nav = useNavigate()

  const prevTaskStatusesRef = useRef<Record<string, string>>({})

  const load = useCallback(async () => {
    const [td, ad] = await Promise.all([api.tasks.list(teamId), api.agents.list(teamId)])
    const newTasks = td.tasks ?? []
    setTasks(newTasks)
    setAgents(ad.agents ?? [])
    if (isInitialLoad) setIsInitialLoad(false)

    // Fire notifications for tasks whose status changed since last poll
    const agentMap = new Map((ad.agents ?? []).map(a => [a.id, a.name]))
    for (const t of newTasks) {
      const prev = prevTaskStatusesRef.current[t.id]
      if (prev && prev !== t.status) {
        const notif = STATUS_NOTIF[t.status]
        const agentName = agentMap.get(t.agent_id) ?? 'Agent'
        if (notif) notify(notif.title(agentName), notif.body(t.subject), t.id)
      }
    }
    prevTaskStatusesRef.current = Object.fromEntries(newTasks.map(t => [t.id, t.status]))
  }, [teamId])

  useEffect(() => { load() }, [load])

  // Poll inbox while any task is active
  useEffect(() => {
    const hasActive = tasks.some(t => ['pending', 'running', 'waiting_input'].includes(t.status))
    if (!hasActive) return
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [tasks, load])

  async function compose(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    try {
      let scheduledAt: number | undefined
      if (scheduledDate && scheduledDate.getTime() > Date.now()) {
        scheduledAt = scheduledDate.getTime()
      }
      await api.tasks.create({ 
        agent_id: agentId, 
        subject, 
        team_id: teamId, 
        body: taskBody || undefined,
        scheduled_at: scheduledAt 
      })
      trackEvent('task_created', { agent_id: agentId, team_id: teamId, scheduled: !!scheduledAt });
      setShowCompose(false); 
      setSubject(''); 
      setTaskBody(''); 
      setAgentId('')
      setShowSchedulePicker(false)
      setScheduledDate(undefined)
      load()
    } finally { setCreating(false) }
  }

  async function handleDeleteTask(taskId: string) {
    await api.tasks.delete(taskId)
    trackEvent('task_deleted', { task_id: taskId });
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

  const filteredTasks = useMemo(() => {
    const now = Date.now()
    if (activeFilter === 'all') return tasks
    if (activeFilter === 'system') return tasks.filter(t => t.first_message_role === 'system' && t.first_message_type !== 'note-to-inbox')
    if (activeFilter === 'mine') return tasks.filter(t => t.first_message_role === 'user' && t.sender_id === internalUserId && t.first_message_type !== 'note-to-inbox')
    if (activeFilter === 'from-note') return tasks.filter(t => t.first_message_type === 'note-to-inbox')
    if (activeFilter === 'scheduled') return tasks.filter(t => t.status === 'scheduled' || (t.scheduled_at && t.scheduled_at > now))
    return tasks
  }, [tasks, activeFilter, internalUserId])

  const hasSystem = useMemo(() => tasks.some(t => t.first_message_role === 'system' && t.first_message_type !== 'note-to-inbox'), [tasks])
  const hasMine = useMemo(() => tasks.some(t => t.first_message_role === 'user' && t.sender_id === internalUserId && t.first_message_type !== 'note-to-inbox'), [tasks])
  const hasNotes = useMemo(() => tasks.some(t => t.first_message_type === 'note-to-inbox'), [tasks])
  const hasScheduled = useMemo(() => {
    const now = Date.now()
    return tasks.some(t => t.status === 'scheduled' || (t.scheduled_at && t.scheduled_at > now))
  }, [tasks])

  return (
    <div className="animate-fade-in">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-1.5">
          <h2 className="text-2xl font-semibold">Inbox</h2>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={() => load()} title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Button onClick={() => setShowCompose(true)}>
          New message
        </Button>
      </div>

      {(hasSystem || hasMine || hasNotes || hasScheduled) && (
        <div className="flex items-center gap-1.5 mb-6 flex-wrap">
          <Button
            variant={activeFilter === 'all' ? 'default' : 'outline'}
            size="sm"
            className="h-7 rounded-full px-3 text-xs"
            onClick={() => setActiveFilter('all')}
          >
            All
          </Button>
          {hasSystem && (
            <Button
              variant={activeFilter === 'system' ? 'default' : 'outline'}
              size="sm"
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => setActiveFilter(activeFilter === 'system' ? 'all' : 'system')}
            >
              System
            </Button>
          )}
          {hasMine && (
            <Button
              variant={activeFilter === 'mine' ? 'default' : 'outline'}
              size="sm"
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => setActiveFilter(activeFilter === 'mine' ? 'all' : 'mine')}
            >
              Mine
            </Button>
          )}
          {hasNotes && (
            <Button
              variant={activeFilter === 'from-note' ? 'default' : 'outline'}
              size="sm"
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => setActiveFilter(activeFilter === 'from-note' ? 'all' : 'from-note')}
            >
              From Note
            </Button>
          )}
          {hasScheduled && (
            <Button
              variant={activeFilter === 'scheduled' ? 'default' : 'outline'}
              size="sm"
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => setActiveFilter(activeFilter === 'scheduled' ? 'all' : 'scheduled')}
            >
              Scheduled
            </Button>
          )}
        </div>
      )}

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
              
              {/* Schedule picker */}
              {showSchedulePicker && (
                <div className="border border-border rounded-lg p-3">
                  <DateTimePicker
                    date={scheduledDate}
                    setDate={setScheduledDate}
                  />
                </div>
              )}
            </div>
            <DialogFooter>
              {!showSchedulePicker && (
                <Button type="button" variant="ghost" onClick={() => setShowSchedulePicker(true)} className="mr-auto">
                  <Clock className="h-4 w-4 mr-1.5" />
                  Schedule
                </Button>
              )}
              <Button type="button" variant="outline" onClick={() => {
                setShowCompose(false)
                setShowSchedulePicker(false)
                setScheduledDate(undefined)
              }}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? '...' : (scheduledDate ? 'Schedule' : 'Send')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-2">
        {isInitialLoad ? (
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
        ) : filteredTasks.length === 0 ? (
          <p className="text-muted-foreground">No messages yet.</p>
        ) : (
          filteredTasks.map(t => (
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

/** Intermediate agent activity row — compact, expandable, skimmable. */
function ActivityRow({ message }: { message: Message }) {
  const isPending = message.type === 'permission_request' && message.interaction_status === 'pending'
  const [expanded, setExpanded] = useState(isPending)
  const type = message.type

  // Derive icon + label + preview from type and body
  let Icon = Terminal
  let label: string = type ?? 'output'
  let preview = ''
  let detail = message.body

  if (type === 'thinking') {
    Icon = Brain
    label = 'thinking'
    preview = message.body.slice(0, 80).replace(/\n/g, ' ')
  } else if (type === 'tool_call') {
    Icon = Wrench
    try {
      const p = JSON.parse(message.body)
      label = p.name ?? 'tool_call'
      const inputStr = p.input !== undefined ? JSON.stringify(p.input) : ''
      preview = inputStr.slice(0, 80)
      detail = p.input !== undefined ? JSON.stringify(p.input, null, 2) : message.body
    } catch {
      preview = message.body.slice(0, 80)
    }
  } else if (type === 'tool_result') {
    Icon = Terminal
    try {
      const p = JSON.parse(message.body)
      const out = p.output ?? p.result ?? message.body
      label = p.name ? `${String(p.name)} result` : 'tool_result'
      preview = String(out).slice(0, 80).replace(/\n/g, ' ')
      detail = String(out)
    } catch {
      preview = message.body.slice(0, 80).replace(/\n/g, ' ')
    }
  } else if (type === 'permission_request') {
    Icon = ShieldAlert
    try {
      const p = JSON.parse(message.json_payload ?? message.body)
      const toolName: string = p.tool_name ?? 'unknown'
      label = `permission · ${toolName}`
      const inputStr = p.tool_input !== undefined ? JSON.stringify(p.tool_input) : ''
      preview = inputStr.slice(0, 80)
      detail = p.tool_input !== undefined ? JSON.stringify(p.tool_input, null, 2) : message.body
    } catch {
      label = 'permission'
      preview = message.body.slice(0, 80)
    }
  } else {
    // 'output' or any unknown typed message
    Icon = Terminal
    label = type ?? 'output'
    preview = message.body.slice(0, 80).replace(/\n/g, ' ')
  }

  const iconColor = type === 'permission_request' && (isPending ? 'text-amber-500' : 'text-muted-foreground/50')

  return (
    <div className="mb-0.5">
      <button
        onClick={() => setExpanded(x => !x)}
        className="w-full flex items-center gap-2 px-3 py-1 rounded-md text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors group text-left"
      >
        <Icon className={cn('h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100', iconColor)} />
        <span className={cn('font-mono text-[11px] shrink-0 opacity-70', type === 'permission_request' && isPending && 'text-amber-600 dark:text-amber-400 opacity-100 font-semibold')}>{label}</span>
        <span className="font-mono text-[11px] truncate flex-1 opacity-50">{preview}</span>
        {type === 'permission_request' && message.interaction_status === 'resolved' && (
          <span className="text-[10px] font-medium text-muted-foreground/60 shrink-0">{message.interaction_response}</span>
        )}
        <ChevronRight className={cn('h-3 w-3 shrink-0 opacity-0 group-hover:opacity-40 transition-transform', expanded && 'rotate-90 opacity-40')} />
      </button>
      {expanded && (
        <div className={cn('mx-3 mb-1 rounded border overflow-x-auto', type === 'permission_request' && isPending ? 'border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-950/10' : 'border-border/40 bg-muted/30')}>
          <pre className="px-3 py-2 text-[11px] font-mono text-foreground/70 whitespace-pre-wrap break-all leading-relaxed">{detail}</pre>
          {type === 'permission_request' && message.interaction_status === 'resolved' && (
            <div className="px-3 py-2 border-t border-border/30 text-[11px] text-muted-foreground">
              <span className="font-semibold">Reply: </span>{message.interaction_response}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MessageBubble({ message, agentName, taskId, onDelete, onEdit }: {
  message: Message;
  agentName?: string;
  taskId?: string;
  onDelete?: (msgId: string) => void;
  onEdit?: (msg: Message) => void;
}) {
  const isUser = message.role === 'user'
  const isAgent = message.role === 'agent'
  const isSystem = message.role === 'system'
  const isScheduled = isUser && message.scheduled_at != null && message.scheduled_at > Date.now()
  const [copied, setCopied] = useState(false)

  function copyBody() {
    navigator.clipboard.writeText(message.body).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  if (isSystem) {
    return (
      <div className="flex justify-center my-3">
        <div className="bg-muted/50 text-muted-foreground text-[10px] uppercase tracking-wider font-semibold px-3 py-1 rounded-full border border-border/50">
          {message.body}
        </div>
      </div>
    )
  }

  // Note-to-inbox user message — show as a collapsible card (content can be very long)
  if (isUser && message.type === 'note-to-inbox') {
    const [expanded, setExpanded] = useState(false)
    let noteTitle = ''
    try { noteTitle = JSON.parse(message.json_payload ?? '{}').note_title ?? '' } catch {}
    return (
      <div className="flex justify-start my-2 mx-3">
        <div className="max-w-[80%] rounded-xl border border-border/60 bg-muted/30 overflow-hidden">
          <button
            className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-muted/50 transition-colors"
            onClick={() => setExpanded(e => !e)}
          >
            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-medium text-foreground/80 flex-1 truncate">{noteTitle || 'Note'}</span>
            <span className="text-[10px] text-muted-foreground">{expanded ? 'Hide' : 'Show content'}</span>
          </button>
          {expanded && (
            <pre className="px-3 pb-3 text-[11px] font-mono text-foreground/70 whitespace-pre-wrap break-words leading-relaxed border-t border-border/40 pt-2 max-h-64 overflow-y-auto">
              {message.body}
            </pre>
          )}
        </div>
      </div>
    )
  }

  // Intermediate agent message → compact activity row
  if (isAgent && message.type != null) {
    return <ActivityRow message={message} />
  }

  const time = new Date(message.created_at).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  function formatScheduleTime(timestamp: number): string {
    const date = new Date(timestamp)
    const now = new Date()
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const timeStr = date.toLocaleString([], { hour: '2-digit', minute: '2-digit' })
    if (date.toDateString() === now.toDateString()) return `Today at ${timeStr}`
    if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow at ${timeStr}`
    return date.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const scheduledTime = message.scheduled_at ? formatScheduleTime(message.scheduled_at) : null

  // Final / regular message — full bubble
  return (
    <div className={cn(
      'rounded-xl border mb-3 overflow-hidden transition-shadow hover:shadow-sm',
      isUser ? 'border-primary/20 bg-primary/[0.04]' : 'border-border/60 bg-card'
    )}>
      <div className={cn(
        'flex items-center gap-2.5 px-4 py-2.5 border-b',
        isUser ? 'border-primary/10' : 'border-border/40'
      )}>
        <div className={cn(
          'w-7 h-7 rounded-full flex items-center justify-center shrink-0',
          isUser ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
        )}>
          {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
        </div>
        <span className="text-sm font-semibold flex-1 text-foreground">
          {isUser ? 'You' : (agentName || 'Agent')}
        </span>
        {isScheduled && scheduledTime && (
          <span className="flex items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 px-1.5 py-0.5 rounded">
              Scheduled
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {scheduledTime}
            </span>
          </span>
        )}
        <span className="text-xs text-muted-foreground">{time}</span>
        {isScheduled && onEdit && (
          <button onClick={() => onEdit(message)} className="ml-1 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Edit scheduled message">
            <Edit className="h-3.5 w-3.5" />
          </button>
        )}
        {isScheduled && onDelete && (
          <button onClick={() => onDelete(message.id)} className="ml-1 p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors" title="Delete scheduled message">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button onClick={copyBody} className="ml-1 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Copy message">
          {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="px-4 py-3.5">
        <div className={cn('text-sm leading-relaxed whitespace-pre-wrap select-text', isScheduled ? 'text-foreground/60' : 'text-foreground/90')}>
          {message.body}
        </div>
        {isAgent && message.transcript_key && taskId && (
          <div className="mt-3 pt-2.5 border-t border-border/30">
            <TranscriptButton taskId={taskId} msgId={message.id} />
          </div>
        )}
      </div>
    </div>
  )
}

function TaskThread({ teamId, plan, internalUserId }: { teamId: string; plan: 'free' | 'pro'; internalUserId: string | null }) {
  const { taskId } = useParams<{ taskId: string }>()
  const [task, setTask] = useState<Task | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [liveLines, setLiveLines] = useState<string[]>([])
  const [watching, setWatching] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [showForward, setShowForward] = useState(false)
  const [forwardAgentId, setForwardAgentId] = useState('')
  const [forwardInstructions, setForwardInstructions] = useState('')
  const [forwarding, setForwarding] = useState(false)
  const [showSchedulePicker, setShowSchedulePicker] = useState(false)
  const [scheduledDate, setScheduledDate] = useState<Date | undefined>(undefined)
  const [editingMessage, setEditingMessage] = useState<Message | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const replyFormRef = useRef<HTMLFormElement>(null)
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

  const agentMap = useMemo(() => Object.fromEntries(agents.map(a => [a.id, a])), [agents])

  function taskStatus(t: Task): string {
    if (t.status === 'pending') {
      const agent = agentMap[t.agent_id]
      if (agent && (agent.status === 'running' || agent.status === 'waiting_input')) return 'queued'
    }
    return t.status
  }

  useEffect(() => { load() }, [load])
  useEffect(() => { if (watching) setShowLog(true) }, [watching])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length, liveLines.length])

  // Auto-poll while the task is active so messages appear without manual refresh
  // Pro users get 2s polling; free users get 5s
  const pollInterval = plan === 'pro' ? 2000 : 5000
  useEffect(() => {
    if (!task || watching) return
    if (!['running', 'waiting_input', 'pending'].includes(task.status)) return
    const t = setInterval(load, pollInterval)
    return () => clearInterval(t)
  }, [task?.status, watching, load, pollInterval])

  // Notify on every status transition (running, waiting_input, done, failed)
  const prevStatusRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!task) return
    const prev = prevStatusRef.current
    prevStatusRef.current = task.status
    if (!prev || prev === task.status) return
    const notif = STATUS_NOTIF[task.status]
    const agentName = agentMap[task.agent_id]?.name ?? 'Agent'
    if (notif) notify(notif.title(agentName), notif.body(task.subject), task.id)
  }, [task?.status, task?.subject, task?.id, agentMap])

  async function startLive() {
    if (!task || esRef.current) return
    trackEvent('live_view_started', { task_id: task.id, agent_id: task.agent_id });
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
    trackEvent('task_deleted', { task_id: taskId });
    nav('/dashboard')
  }

  async function closeTask() {
    if (!taskId) return
    await api.tasks.close(taskId)
    trackEvent('task_closed', { task_id: taskId });
    nav('/dashboard')
  }

  async function forwardToAgent() {
    if (!taskId || !forwardAgentId) return
    setForwarding(true)
    try {
      const { task_id } = await api.tasks.forward(taskId, forwardAgentId, forwardInstructions)
      trackEvent('task_forwarded', { from_task_id: taskId, to_agent_id: forwardAgentId, new_task_id: task_id });
      setShowForward(false)
      setForwardInstructions('')
      nav(`/dashboard/tasks/${task_id}`)
    } finally { setForwarding(false) }
  }

  async function handlePermissionOption(opt: string) {
    if (!taskId || sending) return
    setSending(true)
    try {
      await api.messages.create(taskId, opt)
      trackEvent('permission_option_selected', { task_id: taskId, option: opt })
      load()
    } finally { setSending(false) }
  }

  async function sendReply(e: React.FormEvent) {
    e.preventDefault()
    if (!taskId || !reply.trim()) return
    setSending(true)
    try {
      let scheduledAt: number | undefined
      if (scheduledDate && scheduledDate.getTime() > Date.now()) {
        scheduledAt = scheduledDate.getTime()
      }
      await api.messages.create(taskId, reply, scheduledAt)
      trackEvent('message_sent', { task_id: taskId, role: 'user', scheduled: !!scheduledAt });
      setReply('')
      setShowSchedulePicker(false)
      setScheduledDate(undefined)
      load()
    } finally { setSending(false) }
  }

  async function deleteScheduledMessage(msgId: string) {
    if (!taskId || !confirm('Delete this scheduled message?')) return
    await api.messages.delete(taskId, msgId)
    trackEvent('scheduled_message_deleted', { task_id: taskId, msg_id: msgId });
    load()
  }

  function editScheduledMessage(msg: Message) {
    setEditingMessage(msg)
    setReply(msg.body)
    setShowSchedulePicker(true)
    if (msg.scheduled_at) {
      setScheduledDate(new Date(msg.scheduled_at))
    }
  }

  async function saveEditedMessage(e: React.FormEvent) {
    e.preventDefault()
    if (!taskId || !editingMessage || !reply.trim()) return
    setSending(true)
    try {
      let scheduledAt: number | undefined
      if (scheduledDate && scheduledDate.getTime() > Date.now()) {
        scheduledAt = scheduledDate.getTime()
      }
      await api.messages.update(taskId, editingMessage.id, reply, scheduledAt)
      trackEvent('scheduled_message_edited', { task_id: taskId, msg_id: editingMessage.id });
      setReply('')
      setEditingMessage(null)
      setShowSchedulePicker(false)
      setScheduledDate(undefined)
      load()
    } finally { setSending(false) }
  }

  const agentName = useMemo(() => {
    if (!task) return 'Agent'
    return agents.find(a => a.id === task.agent_id)?.name || 'Agent'
  }, [task, agents])

  // A scheduled reply pending delivery blocks the reply box (user must cancel it first).
  // When internalUserId is not yet loaded, match any pending scheduled user message as a
  // conservative fallback so the reply box never incorrectly shows during load.
  const pendingScheduledReply = useMemo(() => {
    const now = Date.now()
    return messages.find(
      m => m.role === 'user'
        && m.scheduled_at != null
        && m.scheduled_at > now
        && (!internalUserId || m.sender_id === internalUserId)
    ) ?? null
  }, [messages, internalUserId])

  // Options from the last pending permission_request — backward scan to avoid array copy.
  const permissionOptions = useMemo((): string[] | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.type === 'permission_request' && m.interaction_status === 'pending') {
        try {
          const p = JSON.parse(m.json_payload ?? '')
          if (Array.isArray(p.options) && p.options.length > 0) return p.options as string[]
        } catch {}
        break
      }
    }
    return null
  }, [messages])

  return (
    <div className="animate-fade-in w-full">

      {/* ── Gmail-style thread header ── */}
      <div className="flex items-start gap-2 mb-6 pb-5 border-b border-border/50">
        <Button
          variant="ghost" size="icon"
          onClick={() => nav('/dashboard')}
          className="shrink-0 mt-0.5 -ml-2"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="flex-1 min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight leading-snug break-words">
            {task?.subject ?? '…'}
          </h1>
          <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground flex-wrap">
            {task && <StatusBadge status={taskStatus(task)} />}
            <span className="flex items-center gap-1">
              <Bot className="h-3.5 w-3.5" />
              {agentName}
            </span>
            <span>·</span>
            <span>{task ? relativeTime(task.created_at) : '…'}</span>
            {messages.length > 0 && (
              <>
                <span>·</span>
                <span>{messages.length} message{messages.length !== 1 ? 's' : ''}</span>
              </>
            )}
          </div>
        </div>

        {/* Action buttons — right side */}
        <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
          {task && task.status === 'running' && !watching && (
            <Button onClick={startLive} size="sm" variant="outline" className="hidden sm:flex">
              <Play className="h-3.5 w-3.5 mr-1.5" />
              Watch live
            </Button>
          )}
          {task && task.status === 'running' && !watching && (
            <Button onClick={startLive} size="icon" variant="outline" className="sm:hidden h-8 w-8">
              <Play className="h-3.5 w-3.5" />
            </Button>
          )}
          {watching && (
            <Button variant="secondary" size="sm" disabled>
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Live
            </Button>
          )}

          {task && ['done', 'waiting_input'].includes(task.status) && (
            <Dialog open={showForward} onOpenChange={setShowForward}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="hidden sm:flex">
                  <Forward className="h-3.5 w-3.5 mr-1.5" />
                  Forward
                </Button>
              </DialogTrigger>
              <DialogTrigger asChild>
                <Button variant="outline" size="icon" className="sm:hidden h-8 w-8">
                  <Forward className="h-3.5 w-3.5" />
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[400px]">
                <DialogHeader>
                  <DialogTitle>Forward to agent</DialogTitle>
                  <DialogDescription>
                    Creates a new task with the full conversation history as context.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label>Select agent</Label>
                    <Select value={forwardAgentId} onValueChange={setForwardAgentId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose an agent…" />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.map(a => (
                          <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Instructions (Optional)</Label>
                    <Textarea
                      placeholder="e.g. Summarize the previous thread, or Focus on the last message..."
                      value={forwardInstructions}
                      onChange={e => setForwardInstructions(e.target.value)}
                      rows={3}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowForward(false)}>Cancel</Button>
                  <Button onClick={forwardToAgent} disabled={!forwardAgentId || forwarding}>
                    {forwarding ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                    Forward →
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}


          <Button variant="ghost" size="icon" onClick={deleteTask} className="h-8 w-8 hover:bg-destructive/10 hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* ── Messages — natural page scroll ── */}
      <div className="space-y-1 mb-4">
        {messages.map(m => (
          <MessageBubble
            key={m.id}
            message={m}
            agentName={agentName}
            taskId={taskId}
            onDelete={deleteScheduledMessage}
            onEdit={editScheduledMessage}
          />
        ))}

        {liveLines.length > 0 && (
          <div className="mt-3 border rounded-xl overflow-hidden shadow-sm">
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
              <div className="bg-zinc-950 text-emerald-400 p-4 font-mono text-xs whitespace-pre max-h-96 overflow-auto">
                {liveLines.join('\n')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Edit form for scheduled messages — only when agent is waiting for input ── */}
      {editingMessage && task?.status === 'waiting_input' && (
        <div className="border border-amber-200 dark:border-amber-800 rounded-xl overflow-hidden shadow-sm bg-background">
          <div className="px-4 py-2.5 border-b border-amber-200/60 dark:border-amber-800/60 flex items-center gap-2 bg-amber-50/50 dark:bg-amber-950/20">
            <Clock className="h-3.5 w-3.5 text-amber-600" />
            <span className="text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wider">
              Edit scheduled message
            </span>
          </div>
          <form ref={replyFormRef} onSubmit={saveEditedMessage}>
            <Textarea
              value={reply}
              onChange={e => setReply(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEditedMessage(e as any) }}
              placeholder="Edit your message…"
              rows={4}
              className="border-0 rounded-none resize-none focus-visible:ring-0 text-sm px-4 py-3 bg-transparent"
            />
            <div className="px-4 py-3 border-t border-border/20">
              <DateTimePicker
                date={scheduledDate ?? (editingMessage.scheduled_at ? new Date(editingMessage.scheduled_at) : undefined)}
                setDate={setScheduledDate}
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border/30 bg-muted/10">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditingMessage(null)
                  setReply('')
                  setShowSchedulePicker(false)
                  setScheduledDate(undefined)
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={sending || !reply.trim()} size="sm">
                {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                Save
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* ── Pending scheduled reply banner (blocks reply box) ── */}
      {pendingScheduledReply && !editingMessage && (
        <div className="border border-amber-200 dark:border-amber-800 rounded-xl overflow-hidden shadow-sm bg-amber-50/40 dark:bg-amber-950/10">
          <div className="px-4 py-2.5 border-b border-amber-200/60 dark:border-amber-800/60 flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-amber-600 shrink-0" />
            <span className="text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wider flex-1">
              Scheduled reply
            </span>
            <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800">
              {pendingScheduledReply.scheduled_at
                ? new Date(pendingScheduledReply.scheduled_at).toLocaleString(undefined, {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })
                : ''}
            </Badge>
          </div>
          <div className="px-4 py-3">
            <p className="text-sm text-foreground/80 whitespace-pre-wrap line-clamp-3">
              {pendingScheduledReply.body}
            </p>
          </div>
          <div className="flex items-center gap-2 px-4 py-2.5 border-t border-amber-200/40 dark:border-amber-800/40 bg-amber-50/60 dark:bg-amber-950/20">
            <span className="text-xs text-amber-700/70 dark:text-amber-400/70 flex-1">
              Delete this scheduled reply to send a message now.
            </span>
            {task?.status === 'waiting_input' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-950/40"
                onClick={() => editScheduledMessage(pendingScheduledReply)}
              >
                <Edit className="h-3.5 w-3.5 mr-1.5" />
                Edit
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={() => deleteScheduledMessage(pendingScheduledReply.id)}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* ── Reply box when agent is waiting for input ── */}
      {task && task.status === 'waiting_input' && !pendingScheduledReply && !editingMessage && (
        <div className={cn('border rounded-xl overflow-hidden shadow-sm bg-background', permissionOptions ? 'border-amber-200 dark:border-amber-800' : 'border-border/60')}>
          <div className={cn('px-4 py-2.5 border-b flex items-center gap-2', permissionOptions ? 'border-amber-200/60 dark:border-amber-800/60' : 'border-border/40')}>
            {permissionOptions ? (
              <>
                <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider">Permission Required</span>
              </>
            ) : (
              <>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Reply</span>
                <span className="text-xs text-muted-foreground">to {agentName}</span>
              </>
            )}
          </div>
          {permissionOptions && (
            <div className="px-4 py-3 border-b border-amber-200/40 dark:border-amber-800/40 space-y-1">
              {permissionOptions.map((opt, i) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => handlePermissionOption(opt)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm text-left transition-colors',
                    'hover:bg-amber-50 dark:hover:bg-amber-950/20 hover:text-foreground text-muted-foreground',
                  )}
                >
                  <span className="font-mono text-xs text-amber-500 shrink-0">{i + 1}.</span>
                  <span>{opt}</span>
                </button>
              ))}
            </div>
          )}
          <form ref={replyFormRef} onSubmit={sendReply}>
            <Textarea
              value={reply}
              onChange={e => setReply(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendReply(e as any) }}
              placeholder="Write your reply…"
              rows={4}
              className="border-0 rounded-none resize-none focus-visible:ring-0 text-sm px-4 py-3 bg-transparent"
            />
            {showSchedulePicker && (
              <div className="px-4 py-3 border-t border-border/20">
                <DateTimePicker date={scheduledDate} setDate={setScheduledDate} />
              </div>
            )}
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/30 bg-muted/10">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setShowSchedulePicker(!showSchedulePicker)}
              >
                <Clock className="h-3.5 w-3.5 mr-1.5" />
                {showSchedulePicker ? 'Cancel schedule' : 'Schedule'}
              </Button>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground hidden sm:block">⌘ Enter to send</span>
                <Button type="submit" disabled={sending || !reply.trim()} size="sm">
                  {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                  {scheduledDate ? 'Schedule' : 'Send'}
                </Button>
              </div>
            </div>
          </form>
        </div>
      )}


      {/* ── Sticky action bar ── */}
      {task && !['done', 'failed'].includes(task.status) && (
        <div className="sticky bottom-0 pt-3 pb-1 flex justify-start bg-gradient-to-t from-background via-background to-transparent">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm">
                <CheckCircle className="h-3.5 w-3.5 mr-1.5" />
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

      <div ref={bottomRef} className="h-6" />
    </div>
  )
}

function AgentsView({ teamId, isMaintainer, plan }: { teamId: string; isMaintainer: boolean; plan: 'free' | 'pro' }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [newToken, setNewToken] = useState<{ agentId: string; token: string; agentName: string } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'claude' | 'gemini' | 'opencode' | 'codex'>('claude')
  const [editingRole, setEditingRole] = useState<{ agentId: string; name: string; role: string } | null>(null)
  const [savingRole, setSavingRole] = useState(false)
  const nav = useNavigate()

  const load = useCallback(async () => {
    setIsLoading(true)
    const d = await api.agents.list(teamId)
    setAgents(d.agents ?? [])
    setIsLoading(false)
  }, [teamId])

  useEffect(() => { load() }, [load])

  const atAgentLimit = plan === 'free' && agents.length >= 3

  async function createAgent(e: React.FormEvent) {
    e.preventDefault()
    if (atAgentLimit) return
    setCreating(true)
    try {
      await api.agents.create(teamId, { name })
      trackEvent('agent_created', { team_id: teamId, name });
      setName(''); load()
    } finally { setCreating(false) }
  }

  async function genToken(agentId: string, agentName: string) {
    const d = await api.agents.createToken(teamId, agentId, 'Default')
    trackEvent('agent_token_generated', { agent_id: agentId, team_id: teamId });
    setNewToken({ agentId, token: d.token, agentName })
  }

  async function resetAgent(agentId: string) {
    await api.agents.reset(teamId, agentId)
    trackEvent('agent_reset', { agent_id: agentId, team_id: teamId });
    load()
  }

  async function togglePause(agentId: string, currentlyPaused: boolean) {
    await api.agents.pause(teamId, agentId, !currentlyPaused)
    trackEvent(currentlyPaused ? 'agent_resumed' : 'agent_paused', { agent_id: agentId, team_id: teamId });
    load()
  }

  async function deleteAgent(agentId: string) {
    await api.agents.delete(teamId, agentId)
    trackEvent('agent_deleted', { agent_id: agentId, team_id: teamId });
    load()
  }

  async function saveRole() {
    if (!editingRole) return
    setSavingRole(true)
    try {
      await api.agents.updateRole(teamId, editingRole.agentId, editingRole.role)
      trackEvent('agent_role_updated', { agent_id: editingRole.agentId, team_id: teamId })
      setEditingRole(null)
      load()
    } finally { setSavingRole(false) }
  }

  return (
    <div className="animate-fade-in">
      {/* Edit role dialog */}
      <Dialog open={!!editingRole} onOpenChange={open => { if (!open) setEditingRole(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit role for "{editingRole?.name}"</DialogTitle>
            <DialogDescription>
              Describe this agent's identity, expertise, or purpose. This is shown on the agent card and helps your team understand what the agent does.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={editingRole?.role ?? ''}
            onChange={e => setEditingRole(prev => prev ? { ...prev, role: e.target.value } : null)}
            placeholder="e.g. Senior frontend engineer specialising in React and TypeScript. Handles UI tasks and reviews PRs."
            rows={4}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingRole(null)}>Cancel</Button>
            <Button onClick={saveRole} disabled={savingRole}>
              {savingRole ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-1.5">
          <h2 className="text-2xl font-semibold">Agents</h2>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={() => load()} title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        {plan === 'free' && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-medium">{agents.length}/3 agents</span>
            <Badge 
              variant="secondary" 
              className="cursor-pointer hover:bg-secondary/80 transition-colors uppercase tracking-wider text-[10px] font-bold"
              onClick={() => { trackEvent('upgrade_clicked', { source: 'agents_tab' }); nav('/pricing'); }}
            >
              Upgrade
            </Badge>
          </div>
        )}
      </div>

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
            <p className="text-muted-foreground">No agents yet. {isMaintainer && 'Create one to get started.'}</p>
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
                      {a.reset_pending && (
                        <span className="text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">Resetting…</span>
                      )}
                      {!a.reset_pending && a.paused && (
                        <span className="text-xs font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">Paused</span>
                      )}
                    </div>
                    <StatusBadge status={a.status} />
                  </div>
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  {a.role ? (
                    <p className="text-sm text-muted-foreground mb-2 line-clamp-2">{a.role}</p>
                  ) : isMaintainer ? (
                    <button
                      className="text-xs text-muted-foreground/60 italic mb-2 hover:text-muted-foreground transition-colors text-left"
                      onClick={() => setEditingRole({ agentId: a.id, name: a.name, role: '' })}
                    >
                      + Add role description
                    </button>
                  ) : null}
                  <div className="text-xs text-muted-foreground font-mono truncate">ID: {a.id}</div>
                  <div className="text-xs text-muted-foreground mb-4">
                    Last seen: {a.last_seen ? new Date(a.last_seen).toLocaleString() : 'Never'}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex gap-2">
                      {isMaintainer && (
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
                      )}
                    </div>
                    {isMaintainer && (
                      <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          title="Edit role"
                          onClick={() => setEditingRole({ agentId: a.id, name: a.name, role: a.role ?? '' })}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className={cn("h-8 w-8", a.paused ? "text-amber-600 hover:text-amber-700" : "text-muted-foreground hover:text-foreground")}
                              title={a.paused ? "Resume pulling" : "Stop pulling"}
                            >
                              {a.paused ? <PlayCircle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle className="flex items-center gap-2">
                                {a.paused ? (
                                  <>Resume pulling for "{a.name}"?</>
                                ) : (
                                  <><AlertTriangle className="h-5 w-5 text-amber-500" /> Stop pulling for "{a.name}"?</>
                                )}
                              </AlertDialogTitle>
                              <AlertDialogDescription asChild>
                                {a.paused ? (
                                  <div>
                                    The agent will resume picking up new tasks on its next heartbeat.
                                  </div>
                                ) : (
                                  <div className="space-y-3">
                                    <p>
                                      The agent will stop picking up new tasks on its next heartbeat. Any task currently in progress will finish normally.
                                    </p>
                                    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                                      <span>
                                        To resume, you'll need physical access to the machine running this agent and use the <strong>Resume Pulling</strong> option in the systray icon — or click Resume here in the portal.
                                      </span>
                                    </div>
                                  </div>
                                )}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => togglePause(a.id, !!a.paused)}
                                className={a.paused ? '' : 'bg-amber-600 hover:bg-amber-700 text-white'}
                              >
                                {a.paused ? 'Resume Pulling' : 'Stop Pulling'}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" title="Reset agent">
                              <RotateCcw className="h-4 w-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Reset agent?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Any in-progress tasks for "{a.name}" will be marked as done immediately. On its next heartbeat, the agent will kill all running tmux sessions and go idle, ready to pick up new tasks.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => resetAgent(a.id)}>
                                Reset
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
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
                    )}
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
          : activeTab === 'gemini'
          ? { cmd: 'gemini --yolo', dir: '~/Projects/my-tasksquad-project' }
          : activeTab === 'opencode'
          ? { cmd: 'opencode', dir: '~/Projects/my-tasksquad-project' }
          : { cmd: 'codex', dir: '~/Projects/my-tasksquad-project' }
        
        const snippet = `[[agents]]
id       = "${newToken.agentId}"
name     = "${newToken.agentName}"
token    = "${newToken.token}"
command  = "${config.cmd}"
work_dir = "${config.dir}"`

        return (
          <Card className="border-green-500 bg-green-50 dark:bg-green-950 mb-6">
            <CardHeader>
              <CardTitle className="text-green-700 dark:text-green-400">Token generated</CardTitle>
              <CardDescription className="mb-4">Choose your agent and copy the config</CardDescription>
              <div className="flex bg-muted p-1 rounded-lg text-sm gap-1 w-fit">
                <button 
                  onClick={() => setActiveTab('claude')}
                  className={cn(
                    "px-4 py-1.5 rounded-md transition-all font-medium",
                    activeTab === 'claude' ? "bg-blue-600 text-white shadow-md" : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                  )}
                >
                  Claude
                </button>
                <button 
                  onClick={() => setActiveTab('gemini')}
                  className={cn(
                    "px-4 py-1.5 rounded-md transition-all font-medium",
                    activeTab === 'gemini' ? "bg-purple-600 text-white shadow-md" : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                  )}
                >
                  Gemini
                </button>
                <button 
                  onClick={() => setActiveTab('opencode')}
                  className={cn(
                    "px-4 py-1.5 rounded-md transition-all font-medium",
                    activeTab === 'opencode' ? "bg-orange-600 text-white shadow-md" : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                  )}
                >
                  OpenCode
                </button>
                <button 
                  onClick={() => setActiveTab('codex')}
                  className={cn(
                    "px-4 py-1.5 rounded-md transition-all font-medium",
                    activeTab === 'codex' ? "bg-green-600 text-white shadow-md" : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                  )}
                >
                  Codex
                </button>
              </div>
            </CardHeader>
            <CardContent>
              <pre className="bg-background border rounded-md p-3 text-xs font-mono whitespace-pre overflow-x-auto">
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

      {isMaintainer && (
        <>
          <Separator className="my-6" />
          <h3 className="text-lg font-semibold mb-4">Add agent</h3>
          <form onSubmit={createAgent} className="flex flex-col sm:flex-row gap-2 max-w-md">
            <Input
              id="agent-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Agent name (e.g. frontend-helper)"
              required
            />
            <Button type="submit" disabled={creating || atAgentLimit} className="w-full sm:w-fit shrink-0">
              {creating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
              Create agent
            </Button>
          </form>
          {atAgentLimit && (
            <p className="text-xs text-muted-foreground mt-2">
              Free plan limit reached. <button onClick={() => { trackEvent('upgrade_clicked', { source: 'agents_create' }); nav('/pricing'); }} className="underline text-primary">Upgrade to Pro</button> for more agents.
            </p>
          )}
        </>
      )}
    </div>
  )
}


const FREE_MEMBER_LIMIT = 5

function MembersView({ teamId, currentTeam, plan, internalUserId }: { teamId: string; currentTeam: Team | undefined; plan: 'free' | 'pro'; internalUserId: string | null }) {
  const [members, setMembers] = useState<Member[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')
  const currentUserId = internalUserId || auth.currentUser?.uid
  const nav = useNavigate()

  const isOwner = currentTeam?.role === 'owner'
  const atMemberLimit = plan === 'free' && members.length >= FREE_MEMBER_LIMIT

  const load = useCallback(async () => {
    setIsLoading(true)
    const d = await api.members.list(teamId)
    setMembers(d.members ?? [])
    setIsLoading(false)
  }, [teamId])

  useEffect(() => { load() }, [load])

  async function addMember(e: React.FormEvent) {
    e.preventDefault()
    if (atMemberLimit) return
    setAdding(true)
    setAddError('')
    try {
      await api.members.add(teamId, email)
      trackEvent('member_added', { team_id: teamId, member_email: email });
      setEmail('')
      load()
    } catch (err: any) {
      setAddError(err?.error ?? 'Failed to add member')
    } finally { setAdding(false) }
  }

  async function removeMember(userId: string) {
    const isSelf = userId === currentUserId
    await api.members.remove(teamId, userId)
    trackEvent(isSelf ? 'project_left' : 'member_removed', { team_id: teamId, member_id: userId });
    if (isSelf) {
      window.location.href = '/dashboard'
    } else {
      load()
    }
  }

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-1.5">
          <h2 className="text-2xl font-semibold">Members</h2>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={() => load()} title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        {plan === 'free' && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-medium">{members.length}/{FREE_MEMBER_LIMIT} members</span>
            <Badge 
              variant="secondary" 
              className="cursor-pointer hover:bg-secondary/80 transition-colors uppercase tracking-wider text-[10px] font-bold"
              onClick={() => { trackEvent('upgrade_clicked', { source: 'members_tab' }); nav('/pricing'); }}
            >
              Upgrade
            </Badge>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 mb-8">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-3 sm:p-4 flex items-center gap-4">
                  <div className="h-10 w-10 rounded-full bg-muted shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-muted rounded w-1/4" />
                    <div className="h-3 bg-muted rounded w-1/3" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {members.map(m => (
              <Card key={m.id} className="group border shadow-none hover:bg-accent/50 transition-colors">
                <CardContent className="p-3 sm:p-4 flex items-center gap-4">
                  <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold shrink-0">
                    {(m.email[0] || '?').toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate" title={m.email}>{m.email}</span>
                      {m.id === currentUserId && <Badge variant="secondary" className="text-[10px] h-4 px-1">You</Badge>}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                      <span className="capitalize">{m.role}</span>
                      <span>•</span>
                      <span>Joined {new Date(m.joined_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    {(isOwner && m.id !== currentUserId && m.role !== 'maintainer') ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove member?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Remove {m.email} from this team?
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => removeMember(m.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Remove
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : (m.id === currentUserId && m.role !== 'owner') ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8 text-muted-foreground hover:text-destructive">
                            Leave
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Leave Project?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Are you sure you want to leave this project? You will no longer have access to it unless you are invited back.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => removeMember(m.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Leave
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {isOwner && (
        <>
          <Separator className="my-6" />
          <h3 className="text-lg font-semibold mb-1">Add member</h3>
          <p className="text-sm text-muted-foreground mb-4">
            The user must already have a TaskSquad account.
          </p>
          <form onSubmit={addMember} className="flex flex-col sm:flex-row gap-2 max-w-md">
            <Input
              id="member-email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="user@example.com"
              required
            />
            <Button type="submit" disabled={adding || atMemberLimit} className="w-full sm:w-fit shrink-0">
              {adding ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
              Add member
            </Button>
          </form>
          {addError && <p className="text-sm text-destructive mt-2">{addError}</p>}
          {atMemberLimit && (
            <p className="text-xs text-muted-foreground mt-2">
              Limit reached. <button onClick={() => { trackEvent('upgrade_clicked', { source: 'members_limit_text' }); nav('/pricing'); }} className="underline text-primary">Upgrade to Pro</button> for more members.
            </p>
          )}
        </>
      )}
    </div>
  )
}

export function SettingsView({ teamName, onDelete, onLeave, plan: _plan, isOwner }: { teamName: string; onDelete: () => Promise<void>; onLeave: () => Promise<void>; plan: 'free' | 'pro'; isOwner: boolean }) {
  const [confirmName, setConfirmName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [leaving, setLeaving] = useState(false)

  return (
    <div className="animate-fade-in">
      <h2 className="text-2xl font-semibold mb-6">Settings</h2>
      <div className="max-w-md space-y-8">
        <div className="bg-muted/50 p-4 rounded-lg border flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Quick Start Guide
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              Need help setting up your AI agents? Check out our step-by-step guide.
            </p>
          </div>
          <Button 
            variant="outline" 
            size="sm" 
            className="w-full sm:w-auto"
            onClick={() => { trackEvent('howto_clicked', { source: 'settings_view' }); window.open('/howto', '_blank') }}
          >
            <ExternalLink className="mr-2 h-4 w-4" />
            Open How To Guide
          </Button>
        </div>

        <div>
          <div className="text-sm text-muted-foreground mb-1 font-medium">Project name</div>
          <div className="text-lg font-semibold">{teamName}</div>
        </div>

        {!isOwner && (
          <div className="space-y-4 pt-4 border-t">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <LogOut className="h-5 w-5" />
              Leave this project
            </h3>
            <p className="text-sm text-muted-foreground">
              You will no longer have access to this project. You'll need to be invited back by an owner to regain access.
            </p>
            
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="w-full sm:w-auto text-destructive border-destructive/20 hover:bg-destructive/10 hover:text-destructive">
                  Leave Project
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Leave Project?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to leave <span className="font-bold text-foreground">"{teamName}"</span>?
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={leaving}
                    onClick={async (e) => {
                      e.preventDefault()
                      setLeaving(true)
                      try {
                        await onLeave()
                      } catch (err) {
                        console.error('Failed to leave project:', err)
                        setLeaving(false)
                      }
                    }}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {leaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Leave Project'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}

        {isOwner && (
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
        )}
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

  const [plan, setPlan] = useState<'free' | 'pro'>('free')
  const [internalUserId, setInternalUserId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showCreateTeam, setShowCreateTeam] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const [createTeamError, setCreateTeamError] = useState('')
  const [creatingTeam, setCreatingTeam] = useState(false)

  useEffect(() => {
    api.me().then(u => {
      setPlan(u.plan)
      setInternalUserId(u.id)
    }).catch(() => {})
    requestNotificationPermission().then(perm => {
      if (perm === 'granted') registerPushToken()
    })
  }, [])

  function handleNav(path: string) {
    nav(path)
    setSidebarOpen(false)
  }

  const isAgents = location.pathname === '/dashboard/agents'
  const isMembers = location.pathname === '/dashboard/members'
  const isConveyors = location.pathname === '/dashboard/conveyor'
  const isSettings = location.pathname === '/dashboard/settings'
  const isNotes = location.pathname.startsWith('/dashboard/notes')
  if (isLoadingTeams) return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  )

  if (!teamId) return <CreateTeam onCreated={createTeam} />

  const atTeamLimit = plan === 'free' && teams.length >= FREE_TEAM_LIMIT

  async function handleCreateTeam(e: React.FormEvent) {
    e.preventDefault()
    if (atTeamLimit) {
      setCreateTeamError(`Free plan allows up to ${FREE_TEAM_LIMIT} projects. Upgrade to Pro for unlimited projects.`)
      return
    }
    setCreatingTeam(true)
    try {
      await createTeam(newTeamName)
      setNewTeamName('')
      setShowCreateTeam(false)
      setCreateTeamError('')
    } catch (err: any) {
      setCreateTeamError(err?.error ?? 'Failed to create project')
    } finally {
      setCreatingTeam(false)
    }
  }

  async function handleDeleteProject() {
    if (!teamId) return
    await api.teams.delete(teamId)
    trackEvent('project_deleted', { team_id: teamId });
    // Force reload to clear all states and re-fetch teams
    window.location.href = '/dashboard'
  }

  async function handleLeaveProject() {
    if (!teamId) return
    const id = internalUserId || auth.currentUser?.uid
    if (!id) return
    await api.members.remove(teamId, id)
    trackEvent('project_left', { team_id: teamId, member_id: id });
    // Force reload to clear all states and re-fetch teams
    window.location.href = '/dashboard'
  }

  const currentTeam = teams.find(t => t.id === teamId)
  const isOwner = currentTeam?.role === 'owner'
  const isMaintainer = isOwner || currentTeam?.role === 'maintainer'

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
        'pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)] md:pt-0 md:pb-0',
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
            variant={!isAgents && !isSettings && !isMembers && !isNotes ? 'secondary' : 'ghost'}
            className="w-full justify-start mb-1"
            onClick={() => handleNav('/dashboard')}
          >
            <Inbox className="mr-2 h-4 w-4" />
            Inbox
          </Button>
          <Button
            variant={isNotes ? 'secondary' : 'ghost'}
            className="w-full justify-start mb-1"
            onClick={() => handleNav('/dashboard/notes')}
          >
            <FileText className="mr-2 h-4 w-4" />
            Notes
            </Button>
            <Button
            variant={isConveyors ? 'secondary' : 'ghost'}
            className="w-full justify-start mb-1"
            onClick={() => handleNav('/dashboard/conveyor')}
            >
            <Repeat className="mr-2 h-4 w-4" />
            Conveyor
            </Button>
            <Button
            variant={isAgents ? 'secondary' : 'ghost'}            className="w-full justify-start mb-1"
            onClick={() => handleNav('/dashboard/agents')}
          >
            <Bot className="mr-2 h-4 w-4" />
            Agents
          </Button>
          <Button
            variant={isMembers ? 'secondary' : 'ghost'}
            className="w-full justify-start mb-1"
            onClick={() => handleNav('/dashboard/members')}
          >
            <Users className="mr-2 h-4 w-4" />
            Members
          </Button>
          <Button
            variant={isSettings ? 'secondary' : 'ghost'}
            className="w-full justify-start mb-1"
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
        <div className="px-4 pb-2">
          {plan === 'pro' ? (
            <Badge variant="default" className="text-xs">
              Pro
            </Badge>
          ) : (
            <button 
              onClick={() => { trackEvent('pricing_viewed', { from: 'sidebar_badge' }); nav('/pricing'); }}
              className="hover:opacity-80 transition-opacity"
            >
              <Badge variant="secondary" className="text-xs cursor-pointer hover:bg-secondary/80">
                Free plan
              </Badge>
            </button>
          )}
        </div>
        <div className="p-2">
          <Button variant="ghost" className="w-full justify-start text-muted-foreground" onClick={() => { trackEvent('user_logged_out'); signOut(auth); }}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex items-center gap-3 px-4 pt-[calc(0.75rem+env(safe-area-inset-top,0px))] pb-3 border-b bg-background md:hidden shrink-0">
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
        <main className="flex-1 overflow-auto p-4 sm:p-8 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
        <Routes>
          <Route path="/" element={<InboxView teamId={teamId} internalUserId={internalUserId} />} />
          <Route path="/tasks/:taskId" element={<TaskThread teamId={teamId} plan={plan} internalUserId={internalUserId} />} />
          <Route path="/notes" element={<Notes teamId={teamId} />} />
          <Route path="/notes/:noteId" element={<NoteDetail teamId={teamId} />} />
          <Route path="/conveyor" element={<Conveyors teamId={teamId} />} />
          <Route path="/agents" element={<AgentsView teamId={teamId} isMaintainer={isMaintainer} plan={plan} />} />          <Route path="/members" element={<MembersView teamId={teamId} currentTeam={currentTeam} plan={plan} internalUserId={internalUserId} />} />
          <Route path="/settings" element={<SettingsView teamName={teamName} onDelete={handleDeleteProject} onLeave={handleLeaveProject} plan={plan} isOwner={isOwner} />} />
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
              <Button type="submit" disabled={creatingTeam || atTeamLimit}>
                {creatingTeam ? '...' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

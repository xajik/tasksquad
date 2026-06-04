import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  api,
  type Planner,
  type PhaseStatus,
  type PlannerStatus,
  type SupervisorStatus,
  type Agent,
  type SubAgent,
} from '../lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Plus,
  ArrowLeft,
  ThumbsUp,
  ThumbsDown,
  Trash2,
  Layers,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function PlannerStatusBadge({ status }: { status: PlannerStatus }) {
  const map: Record<PlannerStatus, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; className?: string }> = {
    pending:   { variant: 'secondary' },
    running:   { variant: 'secondary', className: 'bg-green-100 text-green-800 border-transparent hover:bg-green-100' },
    completed: { variant: 'default' },
    failed:    { variant: 'destructive' },
  }
  const { variant, className } = map[status]
  return <Badge variant={variant} className={className}>{status}</Badge>
}

function PhaseStatusBadge({ status }: { status: PhaseStatus }) {
  const map: Record<PhaseStatus, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; className?: string }> = {
    pending:     { variant: 'secondary' },
    in_progress: { variant: 'secondary', className: 'bg-blue-100 text-blue-800 border-transparent hover:bg-blue-100' },
    completed:   { variant: 'default' },
    failed:      { variant: 'destructive' },
    reverted:    { variant: 'secondary', className: 'bg-amber-100 text-amber-800 border-transparent hover:bg-amber-100' },
  }
  const { variant, className } = map[status]
  const label = status === 'in_progress' ? 'in progress' : status
  return <Badge variant={variant} className={className}>{label}</Badge>
}

function phaseCircleClass(status: PhaseStatus) {
  switch (status) {
    case 'in_progress': return 'border-blue-500 text-blue-600 bg-blue-50'
    case 'completed':   return 'border-green-500 text-green-600 bg-green-50'
    case 'failed':      return 'border-destructive text-destructive bg-red-50'
    case 'reverted':    return 'border-amber-500 text-amber-600 bg-amber-50'
    default:            return 'border-border text-muted-foreground bg-background'
  }
}

// ── SupervisorStep ────────────────────────────────────────────────────────────

function supervisorStatusClass(status: SupervisorStatus) {
  switch (status) {
    case 'running':   return 'bg-blue-100 text-blue-800'
    case 'completed': return 'bg-secondary text-secondary-foreground'
    case 'failed':    return 'bg-red-100 text-red-800'
    default:          return 'bg-secondary text-muted-foreground'
  }
}

function SupervisorStep({
  supervisorTaskId,
  status,
  verdict,
  onOpen,
}: {
  supervisorTaskId: string
  status: SupervisorStatus
  verdict?: 'yes' | 'no'
  onOpen: () => void
}) {
  return (
    <div className="mt-3 rounded-md border border-dashed border-border bg-secondary/40 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium text-muted-foreground">Supervisor check</span>
          <span className={cn('text-xs rounded-full px-2 py-0.5 font-medium', supervisorStatusClass(status))}>
            {status}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {verdict && (
            verdict === 'yes' ? (
              <span className="text-xs text-green-700 font-medium flex items-center gap-1">
                <span className="text-green-600">✓</span> Requirements met
              </span>
            ) : (
              <span className="text-xs text-destructive font-medium flex items-center gap-1">
                <span>✗</span> Requirements not met
              </span>
            )
          )}
          <button
            className="text-xs text-primary hover:underline flex items-center gap-0.5"
            onClick={onOpen}
            title={`Open supervisor task ${supervisorTaskId}`}
          >
            <ExternalLink className="h-3 w-3" /> View task
          </button>
        </div>
      </div>
    </div>
  )
}

// ── LastResponse collapsible ──────────────────────────────────────────────────

function LastResponse({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > 180
  return (
    <div className="mt-3 border-l-2 border-border pl-3">
      <p className="text-xs font-medium text-muted-foreground mb-1">Last response</p>
      <p className={cn('text-xs text-muted-foreground whitespace-pre-wrap', !expanded && isLong && 'line-clamp-3')}>
        {text}
      </p>
      {isLong && (
        <button
          className="text-xs text-primary mt-1 flex items-center gap-0.5 hover:underline"
          onClick={() => setExpanded(v => !v)}
        >
          {expanded ? <><ChevronUp className="h-3 w-3" /> Show less</> : <><ChevronDown className="h-3 w-3" /> Show more</>}
        </button>
      )}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function Planners({ teamId }: { teamId: string }) {
  const nav = useNavigate()
  const { plannerId } = useParams<{ plannerId?: string }>()
  const [planners, setPlanners] = useState<Planner[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [agents, setAgents] = useState<Agent[]>([])
  const [subAgents, setSubAgents] = useState<SubAgent[]>([])
  // Create form state
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newMaxRetries, setNewMaxRetries] = useState('3')
  const [newAutoClose, setNewAutoClose] = useState(false)
  const [newDefaultSubAgentId, setNewDefaultSubAgentId] = useState<string | undefined>(undefined)
  const [newDefaultHarnessId, setNewDefaultHarnessId] = useState<string | undefined>(undefined)
  const [newPhases, setNewPhases] = useState([
    { name: '', sub_agent_id: undefined as string | undefined, harness_agent_id: undefined as string | undefined, auto_close: false },
  ])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load planners + agents + sub-agents on mount
  useEffect(() => {
    Promise.allSettled([
      api.planners.list(teamId),
      api.agents.list(teamId),
      api.subAgents.list(teamId),
    ]).then(([pr, ar, sr]) => {
      if (pr.status === 'fulfilled') setPlanners(pr.value.planners ?? [])
      if (ar.status === 'fulfilled') setAgents(ar.value.agents ?? [])
      if (sr.status === 'fulfilled') setSubAgents(sr.value.sub_agents ?? [])
      setIsLoading(false)
    })
  }, [teamId])

  // Poll the list every 5s while any planner is running
  const hasRunningPlanners = planners.some(p => p.status === 'running')
  useEffect(() => {
    if (!hasRunningPlanners) return

    const id = setInterval(async () => {
      try {
        const fresh = await api.planners.list(teamId)
        setPlanners(prev => (fresh.planners ?? []).map(fp => {
          const existing = prev.find(p => pid(p) === pid(fp))
          return existing?.phases ? { ...fp, phases: existing.phases } : fp
        }))
      } catch { /* ignore */ }
    }, 5000)
    return () => clearInterval(id)
  }, [teamId, hasRunningPlanners])

  // Load full planner (with phases) whenever the detail URL is active
  useEffect(() => {
    if (!plannerId) return
    api.planners.get(teamId, plannerId).then(full => {
      setPlanners(prev => {
        const exists = prev.some(p => pid(p) === plannerId)
        if (exists) return prev.map(p => pid(p) === plannerId ? full : p)
        return [...prev, full]
      })
    }).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, plannerId])

  // Poll the selected planner every 5s while it is running
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (!plannerId) return

    const pId = (p: Planner) => p.planner_id ?? (p as unknown as { id: string }).id
    const selected = planners.find(p => pId(p) === plannerId)
    if (selected?.status !== 'running') return

    pollRef.current = setInterval(async () => {
      try {
        const fresh = await api.planners.get(teamId, plannerId)
        setPlanners(prev => prev.map(p => pId(p) === plannerId ? fresh : p))
        if (fresh.status !== 'running') clearInterval(pollRef.current!)
      } catch { /* ignore transient errors */ }
    }, 5000)

    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plannerId, planners.find(p => (p.planner_id ?? (p as unknown as {id:string}).id) === plannerId)?.status])

  const agentName = (id?: string) => agents.find(a => a.id === id)?.name ?? id ?? '—'
  const subAgentName = (id?: string) => subAgents.find(s => s.id === id)?.name ?? id ?? '—'

  // The backend exposes planner_id once deployed; before that it only has id.
  const pid = (p: Planner) => p.planner_id ?? (p as unknown as { id: string }).id

  const selected = planners.find(p => pid(p) === plannerId) ?? null

  async function handlePause(pId: string, paused: boolean) {
    await api.planners.update(teamId, pId, { paused })
    setPlanners(prev => prev.map(p =>
      pid(p) === pId ? { ...p, paused } : p
    ))
  }

  async function handlePhaseGrade(taskId: string, grade: 0 | 1) {
    const currentPlannerId = plannerId  // capture before any await
    await api.tasks.grade(taskId, grade)
    if (currentPlannerId) {
      const fresh = await api.planners.get(teamId, currentPlannerId)
      setPlanners(prev => prev.map(p => pid(p) === currentPlannerId ? fresh : p))
    }
  }

  async function handlePlannerVerdict(pId: string, verdict: 0 | 1) {
    const planner = planners.find(p => pid(p) === pId)
    const next = planner?.planner_verdict === verdict ? null : verdict
    await api.planners.update(teamId, pId, { planner_verdict: next })
    setPlanners(prev => prev.map(p =>
      pid(p) === pId ? { ...p, planner_verdict: next ?? undefined } : p
    ))
  }

  function handleAutoCloseToggle(checked: boolean) {
    setNewAutoClose(checked)
    if (checked) {
      setNewPhases(prev => prev.map(p => ({ ...p, auto_close: true })))
    }
  }

  function updatePhase(i: number, patch: Partial<typeof newPhases[0]>) {
    setNewPhases(prev => prev.map((p, j) => j === i ? { ...p, ...patch } : p))
  }

  function resetForm() {
    setNewName('')
    setNewDescription('')
    setNewMaxRetries('3')
    setNewAutoClose(false)
    setNewDefaultSubAgentId(undefined)
    setNewDefaultHarnessId(undefined)
    setNewPhases([{ name: '', sub_agent_id: undefined, harness_agent_id: undefined, auto_close: false }])
  }

  async function handleCreate() {
    if (!newName.trim()) return
    const maxR = Math.max(1, parseInt(newMaxRetries) || 3)
    const res = await api.planners.create(teamId, {
      name: newName.trim(),
      description: newDescription.trim() || undefined,
      max_retries: maxR,
      auto_close: newAutoClose,
      default_sub_agent_id: newDefaultSubAgentId,
      default_harness_agent_id: newDefaultHarnessId,
      phases: newPhases.map(p => ({
        name: p.name.trim() || 'Phase',
        sub_agent_id: p.sub_agent_id,
        harness_agent_id: p.harness_agent_id,
        auto_close: newAutoClose ? true : p.auto_close,
        max_retries: maxR,
      })),
    })
    // Reload list; also fetch the new planner in full (list omits phases)
    const [freshList, freshPlanner] = await Promise.all([
      api.planners.list(teamId),
      api.planners.get(teamId, res.id),
    ])
    const updatedList = (freshList.planners ?? []).map(p =>
      pid(p) === res.id ? freshPlanner : p
    )
    setPlanners(updatedList)
    setShowCreate(false)
    resetForm()
    nav('/dashboard/planner/' + res.id)
  }

  // ── List view ───────────────────────────────────────────────────────────────
  if (!selected) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Planners</h1>
            <p className="text-sm text-muted-foreground mt-1">Coordinate multi-phase work across agents.</p>
          </div>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Planner
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16 text-muted-foreground text-sm">Loading…</div>
        ) : planners.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Layers className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="font-medium">No planners yet</p>
              <p className="text-sm text-muted-foreground mt-1">Create a planner to coordinate multi-phase agent work.</p>
              <Button className="mt-4" onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4 mr-2" />
                New Planner
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {planners.map(planner => (
              <Card key={planner.planner_id} className="hover:shadow-sm transition-shadow">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{planner.name}</span>
                        <PlannerStatusBadge status={planner.status} />
                        {planner.paused && (
                          <Badge variant="secondary" className="bg-amber-100 text-amber-800 border-transparent">
                            <Pause className="h-3 w-3 mr-1" />paused
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground bg-secondary rounded-full px-2 py-0.5">
                          Phase {Math.max(0, planner.current_phase_index) + 1} / {planner.phase_count ?? (planner.phases ?? []).length}
                        </span>
                      </div>
                      {planner.description && (
                        <p className="text-sm text-muted-foreground mt-1 truncate">{planner.description}</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">{formatAgo(planner.created_at)}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {/* Thumbs up/down on planner card */}
                      <button
                        className={cn(
                          'p-1.5 rounded-md transition-colors',
                          planner.planner_verdict === 1
                            ? 'text-green-600 bg-green-50'
                            : 'text-muted-foreground hover:text-green-600 hover:bg-green-50',
                        )}
                        onClick={() => handlePlannerVerdict(pid(planner), 1)}
                        title="Approve planner"
                      >
                        <ThumbsUp className="h-4 w-4" />
                      </button>
                      <button
                        className={cn(
                          'p-1.5 rounded-md transition-colors',
                          planner.planner_verdict === 0
                            ? 'text-destructive bg-red-50'
                            : 'text-muted-foreground hover:text-destructive hover:bg-red-50',
                        )}
                        onClick={() => handlePlannerVerdict(pid(planner), 0)}
                        title="Reject planner"
                      >
                        <ThumbsDown className="h-4 w-4" />
                      </button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-1"
                        onClick={() => nav('/dashboard/planner/' + pid(planner))}
                      >
                        View
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Create dialog */}
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogContent className="sm:max-w-[540px] max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>New Planner</DialogTitle>
              <DialogDescription>Define the phases and agents for your multi-step plan.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="planner-name">Name</Label>
                <Input
                  id="planner-name"
                  placeholder="e.g. Memory Feature"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="planner-desc">
                  Description <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Textarea
                  id="planner-desc"
                  placeholder="What does this planner accomplish?"
                  value={newDescription}
                  onChange={e => setNewDescription(e.target.value)}
                  rows={2}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Default sub-agent</Label>
                  <Select value={newDefaultSubAgentId ?? ''} onValueChange={v => setNewDefaultSubAgentId(v || undefined)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select sub-agent…" />
                    </SelectTrigger>
                    <SelectContent>
                      {subAgents.length === 0
                        ? <SelectItem value="__none" disabled>No sub-agents available</SelectItem>
                        : subAgents.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)
                      }
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Default harness</Label>
                  <Select value={newDefaultHarnessId ?? ''} onValueChange={v => setNewDefaultHarnessId(v || undefined)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select agent…" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.length === 0
                        ? <SelectItem value="__none" disabled>No agents available</SelectItem>
                        : agents.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)
                      }
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="planner-retries">Max retries per phase</Label>
                  <Input
                    id="planner-retries"
                    type="number"
                    min="1"
                    max="10"
                    value={newMaxRetries}
                    onChange={e => setNewMaxRetries(e.target.value)}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none pb-2">
                  <input
                    type="checkbox"
                    checked={newAutoClose}
                    onChange={e => handleAutoCloseToggle(e.target.checked)}
                    className="rounded"
                  />
                  Auto-close all phases
                </label>
              </div>

              <div className="space-y-2">
                <Label>Phases</Label>
                {newPhases.map((phase, i) => (
                  <div key={i} className="border rounded-lg p-3 space-y-2 bg-secondary/30">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Phase {i + 1}</span>
                      {newPhases.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => setNewPhases(prev => prev.filter((_, j) => j !== i))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                    <Input
                      placeholder="Phase name (e.g. Product Research)"
                      value={phase.name}
                      onChange={e => updatePhase(i, { name: e.target.value })}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <Select
                        value={phase.sub_agent_id ?? ''}
                        onValueChange={v => updatePhase(i, { sub_agent_id: v || undefined })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Sub-agent…" />
                        </SelectTrigger>
                        <SelectContent>
                          {subAgents.length === 0
                            ? <SelectItem value="__none" disabled>No sub-agents</SelectItem>
                            : subAgents.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)
                          }
                        </SelectContent>
                      </Select>
                      <Select
                        value={phase.harness_agent_id ?? ''}
                        onValueChange={v => updatePhase(i, { harness_agent_id: v || undefined })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Harness…" />
                        </SelectTrigger>
                        <SelectContent>
                          {agents.length === 0
                            ? <SelectItem value="__none" disabled>No agents</SelectItem>
                            : agents.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)
                          }
                        </SelectContent>
                      </Select>
                    </div>
                    <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={phase.auto_close}
                        onChange={e => updatePhase(i, { auto_close: e.target.checked })}
                        className="rounded"
                      />
                      Auto-close
                    </label>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setNewPhases(prev => [
                    ...prev,
                    {
                      name: '',
                      sub_agent_id: newDefaultSubAgentId,
                      harness_agent_id: newDefaultHarnessId,
                      auto_close: newAutoClose,
                    },
                  ])}
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Add phase
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!newName.trim()}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    )
  }

  // ── Detail view ─────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto">
      <Button variant="ghost" size="sm" className="mb-4 -ml-1 text-muted-foreground" onClick={() => nav('/dashboard/planner')}>
        <ArrowLeft className="h-4 w-4 mr-1.5" />
        Back to Planners
      </Button>

      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-xl">{selected.name}</CardTitle>
              {selected.description && (
                <CardDescription className="mt-1">{selected.description}</CardDescription>
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
              {(selected.status === 'running' || selected.status === 'pending') && (
                <Button
                  variant="outline"
                  size="sm"
                  className={selected.paused
                    ? 'text-green-700 border-green-200 hover:bg-green-50'
                    : 'text-amber-700 border-amber-200 hover:bg-amber-50'
                  }
                  onClick={() => handlePause(pid(selected), !selected.paused)}
                >
                  {selected.paused
                    ? <><Play className="h-3.5 w-3.5 mr-1.5" />Resume</>
                    : <><Pause className="h-3.5 w-3.5 mr-1.5" />Pause</>
                  }
                </Button>
              )}
              <button
                className={cn(
                  'p-1.5 rounded-md transition-colors',
                  selected.planner_verdict === 1
                    ? 'text-green-600 bg-green-50'
                    : 'text-muted-foreground hover:text-green-600 hover:bg-green-50',
                )}
                onClick={() => handlePlannerVerdict(pid(selected), 1)}
                title="Approve planner"
              >
                <ThumbsUp className="h-4 w-4" />
              </button>
              <button
                className={cn(
                  'p-1.5 rounded-md transition-colors',
                  selected.planner_verdict === 0
                    ? 'text-destructive bg-red-50'
                    : 'text-muted-foreground hover:text-destructive hover:bg-red-50',
                )}
                onClick={() => handlePlannerVerdict(pid(selected), 0)}
                title="Reject planner"
              >
                <ThumbsDown className="h-4 w-4" />
              </button>
              <PlannerStatusBadge status={selected.status} />
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap pt-1">
            <span className="text-xs text-muted-foreground bg-secondary rounded-full px-2.5 py-1">
              Phase {Math.max(0, selected.current_phase_index) + 1} of {selected.phase_count ?? (selected.phases ?? []).length}
            </span>
            <span className="text-xs text-muted-foreground bg-secondary rounded-full px-2.5 py-1">
              Max retries: {selected.max_retries}
            </span>
            {selected.paused && (
              <span className="text-xs bg-amber-100 text-amber-800 rounded-full px-2.5 py-1 flex items-center gap-1">
                <Pause className="h-3 w-3" /> Paused — next phase won't start until resumed
              </span>
            )}
            {selected.default_sub_agent_id && (
              <span className="text-xs text-muted-foreground">
                Sub-agent: <span className="text-foreground">{subAgentName(selected.default_sub_agent_id)}</span>
              </span>
            )}
            {selected.default_harness_agent_id && (
              <span className="text-xs text-muted-foreground">
                Harness: <span className="text-foreground">{agentName(selected.default_harness_agent_id)}</span>
              </span>
            )}
            <span className="text-xs text-muted-foreground">{formatAgo(selected.created_at)}</span>
          </div>
        </CardHeader>
      </Card>

      {/* Phase stepper */}
      <div>
        {(selected.phases ?? []).map((phase, idx) => {
          const isLast = idx === (selected.phases ?? []).length - 1
          const hasTask = !!phase.task_id

          return (
            <div key={phase.phase_id} className="flex gap-4">
              {/* Step indicator */}
              <div className="flex flex-col items-center shrink-0">
                <div className={cn(
                  'w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold',
                  phaseCircleClass(phase.status),
                )}>
                  {idx + 1}
                </div>
                {!isLast && (
                  <div
                    className={cn(
                      'w-px flex-1 mt-1',
                      phase.status === 'completed' ? 'bg-border' : 'border-l-2 border-dashed border-border bg-transparent',
                    )}
                    style={{ minHeight: '2rem' }}
                  />
                )}
              </div>

              {/* Phase card */}
              <div className={cn('flex-1 min-w-0', !isLast ? 'pb-4' : 'pb-2')}>
                <Card className={cn(
                  'border',
                  phase.status === 'in_progress' && 'border-blue-200 bg-blue-50/30',
                  phase.status === 'failed' && 'border-destructive/30 bg-red-50/30',
                  phase.status === 'reverted' && 'border-amber-200 bg-amber-50/30',
                )}>
                  <CardContent className="p-4 relative">
                    {/* Header row */}
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium">{phase.name}</span>
                        {hasTask && (
                          <button
                            className="text-muted-foreground hover:text-primary transition-colors shrink-0"
                            onClick={() => nav(`/dashboard/tasks/${phase.task_id}`)}
                            title="Open linked task"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap justify-end shrink-0">
                        <PhaseStatusBadge status={phase.status} />
                        {phase.retry_count > 0 && (
                          <Badge variant="outline" className="text-xs">
                            Retry {phase.retry_count}/{phase.max_retries}
                          </Badge>
                        )}
                      </div>
                    </div>

                    {/* Metadata */}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground mb-2">
                      {phase.sub_agent_id && (
                        <span>Sub-agent: <span className="text-foreground font-medium">{subAgentName(phase.sub_agent_id)}</span></span>
                      )}
                      {phase.harness_agent_id && (
                        <span>Harness: <span className="text-foreground font-medium">{agentName(phase.harness_agent_id)}</span></span>
                      )}
                      {phase.auto_close && (
                        <Badge variant="secondary" className="text-xs py-0">auto-close</Badge>
                      )}
                    </div>

                    {/* Last response for completed/in-progress phases */}
                    {(phase.status === 'completed' || phase.status === 'in_progress') && phase.last_response && (
                      <LastResponse text={phase.last_response} />
                    )}

                    {/* Supervisor step */}
                    {phase.supervisor_task_id && phase.supervisor_status && (
                      <SupervisorStep
                        supervisorTaskId={phase.supervisor_task_id}
                        status={phase.supervisor_status}
                        verdict={phase.supervisor_verdict}
                        onOpen={() => nav(`/dashboard/tasks/${phase.supervisor_task_id}`)}
                      />
                    )}

                    {/* Proceed / Stop — visible once the linked task is done */}
                    {!isLast && phase.status === 'in_progress' && phase.task_id && phase.task_status === 'done' && !phase.user_verdict && !phase.auto_close && (
                      <div className="absolute bottom-3 right-3 flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-green-700 border-green-700 hover:bg-green-50 hover:text-green-700"
                          onClick={() => handlePhaseGrade(phase.task_id!, 1)}
                        >
                          Proceed
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive border-destructive hover:bg-red-50 hover:text-destructive"
                          onClick={() => handlePhaseGrade(phase.task_id!, 0)}
                        >
                          Stop
                        </Button>
                      </div>
                    )}

                    {/* Inbox grade (read-only) */}
                    {phase.user_verdict && (
                      <div className="flex items-center gap-2 mt-3 flex-wrap">
                        {phase.user_verdict === 'approved' ? (
                          <p className="text-xs text-green-700 flex items-center gap-1">
                            <ThumbsUp className="h-3 w-3" /> Graded ↑ in inbox
                          </p>
                        ) : (
                          <p className="text-xs text-destructive flex items-center gap-1">
                            <ThumbsDown className="h-3 w-3" /> Graded ↓ in inbox
                            {phase.retry_count > 0 && (
                              <span className="text-muted-foreground ml-1">— retrying ({phase.retry_count}/{phase.max_retries})</span>
                            )}
                          </p>
                        )}
                        {phase.user_verdict === 'approved' && selected.paused && idx + 1 < (selected.phases ?? []).length && (selected.phases ?? [])[idx + 1].status === 'pending' && (
                          <p className="text-xs text-amber-700 flex items-center gap-1">
                            <Pause className="h-3 w-3" /> Paused — resume planner to start next phase
                          </p>
                        )}
                      </div>
                    )}

                    {/* Reverting indicator */}
                    {phase.status === 'reverted' && (
                      <p className="text-xs text-amber-700 animate-pulse mt-2">Reverting...</p>
                    )}

                    {/* Failed task link */}
                    {phase.status === 'failed' && hasTask && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-2 h-auto p-0 text-destructive hover:text-destructive hover:bg-transparent text-xs"
                        onClick={() => nav(`/dashboard/tasks/${phase.task_id}`)}
                      >
                        View failed task →
                      </Button>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          )
        })}
      </div>

    </div>
  )
}

import { useState, useEffect, useCallback, useMemo } from 'react'
import { api, type Agent, type Conveyor } from '../lib/api'
import { trackEvent } from '../lib/analytics'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { AutocompleteTextarea } from '@/components/AutocompleteTextarea'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import {
  RefreshCw,
  Plus,
  Trash2,
  Pencil,
  Repeat,
  Calendar,
  Bot,
  Loader2,
  Pause,
  Play,
} from 'lucide-react'
import { ConveyorWorkflow } from '../components/ConveyorWorkflow'
import { HowItWorks, HowItWorksToggle } from '../components/HowItWorks'

export function Conveyors({ teamId }: { teamId: string }) {
  const [conveyors, setConveyors] = useState<Conveyor[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [showCompose, setShowCompose] = useState(false)
  const [showHowItWorks, setShowHowItWorks] = useState(false)
  const [subject, setSubject] = useState('')
  const [taskBody, setTaskBody] = useState('')
  const [agentId, setAgentId] = useState<string | undefined>(undefined)
  const [frequency, setFrequency] = useState<'hourly' | 'daily' | 'weekly' | 'monthly'>('daily')
  const [hour, setHour] = useState('9')
  const [minute, setMinute] = useState('0')
  const [dayOfWeek, setDayOfWeek] = useState('1') // Monday
  const [dayOfMonth, setDayOfMonth] = useState('1')
  const [repeatCount, setRepeatCount] = useState('')
  const [endDate, setEndDate] = useState<Date | undefined>(undefined)
  const [autoClose, setAutoClose] = useState(false)
  const [creating, setCreating] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [agentError, setAgentError] = useState(false)

  // Edit dialog state
  const [editConveyor, setEditConveyor] = useState<Conveyor | null>(null)
  const [editSubject, setEditSubject] = useState('')
  const [editBody, setEditBody] = useState('')
  const [editAgentId, setEditAgentId] = useState<string | undefined>(undefined)
  const [editFrequency, setEditFrequency] = useState<'hourly' | 'daily' | 'weekly' | 'monthly'>('daily')
  const [editHour, setEditHour] = useState('9')
  const [editMinute, setEditMinute] = useState('0')
  const [editDayOfWeek, setEditDayOfWeek] = useState('1')
  const [editDayOfMonth, setEditDayOfMonth] = useState('1')
  const [editRepeatCount, setEditRepeatCount] = useState('')
  const [editEndDate, setEditEndDate] = useState<Date | undefined>(undefined)
  const [editAutoClose, setEditAutoClose] = useState(false)
  const [editAgentError, setEditAgentError] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setIsLoading(true)
    const [cd, ad] = await Promise.allSettled([
      api.conveyors.list(teamId),
      api.agents.list(teamId)
    ])
    if (cd.status === 'fulfilled') setConveyors(cd.value.conveyors ?? [])
    else console.error('Failed to load conveyors:', cd.reason)
    if (ad.status === 'fulfilled') setAgents(ad.value.agents ?? [])
    else console.error('Failed to load agents:', ad.reason)
    setIsLoading(false)
  }, [teamId])

  useEffect(() => { load() }, [load])

  async function compose(e: React.FormEvent) {
    e.preventDefault()
    if (!agentId) {
      setAgentError(true)
      return
    }
    setAgentError(false)
    setCreating(true)
    try {
      await api.conveyors.create(teamId, {
        agent_id: agentId,
        subject,
        body: taskBody,
        frequency,
        hour: parseInt(hour),
        minute: parseInt(minute),
        day_of_week: frequency === 'weekly' ? parseInt(dayOfWeek) : undefined,
        day_of_month: frequency === 'monthly' ? parseInt(dayOfMonth) : undefined,
        repeat_count: repeatCount ? parseInt(repeatCount) : undefined,
        end_date: endDate ? endDate.getTime() : undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        auto_close: autoClose || undefined,
      })
      trackEvent('conveyor_created', { agent_id: agentId, team_id: teamId, frequency })
      setShowCompose(false)
      resetForm()
      load()
    } catch (e) {
      console.error('Failed to create conveyor:', e)
    } finally { setCreating(false) }
  }

  function resetForm() {
    setSubject('')
    setTaskBody('')
    setAgentId(undefined)
    setFrequency('daily')
    setHour('9')
    setMinute('0')
    setDayOfWeek('1')
    setDayOfMonth('1')
    setRepeatCount('')
    setEndDate(undefined)
    setAutoClose(false)
    setAgentError(false)
  }

  async function handleDelete(id: string) {
    try {
      await api.conveyors.delete(teamId, id)
      trackEvent('conveyor_deleted', { conveyor_id: id })
      setConveyors(conveyors.filter(c => c.id !== id))
    } catch (e) {
      console.error('Failed to delete conveyor:', e)
    }
  }

  async function handleTogglePause(c: Conveyor) {
    const next = !c.paused
    setConveyors(conveyors.map(x => x.id === c.id ? { ...x, paused: next } : x))
    try {
      await api.conveyors.pause(teamId, c.id, next)
      trackEvent(next ? 'conveyor_paused' : 'conveyor_resumed', { conveyor_id: c.id })
    } catch (e) {
      console.error('Failed to toggle conveyor pause:', e)
      setConveyors(conveyors.map(x => x.id === c.id ? { ...x, paused: c.paused } : x))
    }
  }

function openEdit(c: Conveyor) {
    setEditConveyor(c)
    setEditSubject(c.subject)
    setEditBody(c.body)
    setEditAgentId(c.agent_id)
    setEditFrequency(c.frequency)
    setEditHour(c.hour.toString())
    setEditMinute((c.minute ?? 0).toString())
    setEditDayOfWeek(c.day_of_week?.toString() ?? '1')
    setEditDayOfMonth(c.day_of_month?.toString() ?? '1')
    setEditRepeatCount(c.repeat_count?.toString() ?? '')
    setEditEndDate(c.end_date ? new Date(c.end_date) : undefined)
    setEditAutoClose(!!c.auto_close)
    setEditAgentError(false)
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!editConveyor) return
    if (!editAgentId) { setEditAgentError(true); return }
    setEditAgentError(false)
    setSaving(true)
    try {
      await api.conveyors.update(teamId, editConveyor.id, {
        agent_id: editAgentId,
        subject: editSubject,
        body: editBody,
        frequency: editFrequency,
        hour: parseInt(editHour),
        minute: parseInt(editMinute),
        day_of_week: editFrequency === 'weekly' ? parseInt(editDayOfWeek) : null,
        day_of_month: editFrequency === 'monthly' ? parseInt(editDayOfMonth) : null,
        repeat_count: editRepeatCount ? parseInt(editRepeatCount) : null,
        end_date: editEndDate ? editEndDate.getTime() : null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        auto_close: editAutoClose,
      })
      trackEvent('conveyor_updated', { conveyor_id: editConveyor.id, team_id: teamId })
      setEditConveyor(null)
      load()
    } catch (e) {
      console.error('Failed to update conveyor:', e)
    } finally { setSaving(false) }
  }

  const agentMap = useMemo(() => Object.fromEntries(agents.map(a => [a.id, a])), [agents])

  function formatSchedule(c: Conveyor) {
    const hh = c.hour.toString().padStart(2, '0')
    const mm = (c.minute ?? 0).toString().padStart(2, '0')
    const time = `${hh}:${mm}`
    if (c.frequency === 'hourly') return `Hourly at :${mm}`
    if (c.frequency === 'daily') return `Daily at ${time}`
    if (c.frequency === 'weekly') {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      return `Weekly on ${days[c.day_of_week ?? 0]} at ${time}`
    }
    if (c.frequency === 'monthly') return `Monthly on day ${c.day_of_month} at ${time}`
    return c.frequency
  }

  function formatCycles(c: Conveyor) {
    if (c.repeat_count) {
      const left = Math.max(0, c.repeat_count - c.repeat_counter)
      return `${left} of ${c.repeat_count} left`
    }
    return `${c.repeat_counter} runs`
  }

  return (
    <div className="animate-fade-in">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-1.5">
          <h2 className="text-2xl font-semibold">Conveyor</h2>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={() => load()} title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <HowItWorksToggle show={showHowItWorks} onToggle={() => setShowHowItWorks(!showHowItWorks)} />
        </div>
        <Button onClick={() => setShowCompose(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Conveyor
        </Button>
      </div>

      {showHowItWorks && (
        <HowItWorks title="Recurring Task Scheduler" icon={Repeat} docsLink="/docs" className="mb-6" text="Conveyors schedule tasks on hourly, daily, weekly, or monthly intervals. Each run creates a new task for the assigned agent, with optional max run limits and end dates.">
          <ConveyorWorkflow />
        </HowItWorks>
      )}

      <Dialog open={showCompose} onOpenChange={(open) => { if (!open) resetForm(); setShowCompose(open) }}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>New Conveyor</DialogTitle>
            <DialogDescription>
              Create a recurring task.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={compose}>
            <div className="grid gap-4 py-4">

              {/* Agent */}
              <div className="grid gap-2">
                <Label htmlFor="agent">Agent</Label>
                {agents.length === 0 && !isLoading ? (
                  <p className="text-sm text-muted-foreground">No agents found for this team.</p>
                ) : (
                  <Select value={agentId} onValueChange={(v) => { setAgentId(v); setAgentError(false) }}>
                    <SelectTrigger className={agentError ? 'border-destructive' : ''}>
                      <SelectValue placeholder="Select agent…" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map(a => (
                        <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {agentError && <p className="text-xs text-destructive">Please select an agent.</p>}
              </div>

              {/* Subject */}
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

              {/* Body */}
              <div className="grid gap-2">
                <Label htmlFor="body">Description</Label>
                <AutocompleteTextarea
                  id="body"
                  value={taskBody}
                  onChange={setTaskBody}
                  teamId={teamId}
                  placeholder="Task description"
                  rows={3}
                  className="font-mono text-sm"
                  required
                />
              </div>

              {/* Frequency + Time */}
              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-2">
                  <Label>Repeat</Label>
                  <Select value={frequency} onValueChange={(v: any) => setFrequency(v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hourly">Hourly</SelectItem>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label className={frequency === 'hourly' ? 'opacity-50' : ''}>Hour</Label>
                  <Select value={hour} onValueChange={setHour} disabled={frequency === 'hourly'}>
                    <SelectTrigger className={frequency === 'hourly' ? 'opacity-50' : ''}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 24 }).map((_, i) => (
                        <SelectItem key={i} value={i.toString()}>{i.toString().padStart(2, '0')}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>Minute</Label>
                  <Select value={minute} onValueChange={setMinute}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                        <SelectItem key={m} value={m.toString()}>{m.toString().padStart(2, '0')}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Day of week (weekly) */}
              {frequency === 'weekly' && (
                <div className="grid gap-2">
                  <Label>On</Label>
                  <Select value={dayOfWeek} onValueChange={setDayOfWeek}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Sunday</SelectItem>
                      <SelectItem value="1">Monday</SelectItem>
                      <SelectItem value="2">Tuesday</SelectItem>
                      <SelectItem value="3">Wednesday</SelectItem>
                      <SelectItem value="4">Thursday</SelectItem>
                      <SelectItem value="5">Friday</SelectItem>
                      <SelectItem value="6">Saturday</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Day of month (monthly) */}
              {frequency === 'monthly' && (
                <div className="grid gap-2">
                  <Label>Day of month</Label>
                  <Select value={dayOfMonth} onValueChange={setDayOfMonth}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 31 }).map((_, i) => (
                        <SelectItem key={i + 1} value={(i + 1).toString()}>{i + 1}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Stop conditions */}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="repeatCount">Max runs (empty = ∞)</Label>
                  <Input
                    id="repeatCount"
                    type="number"
                    min="1"
                    value={repeatCount}
                    onChange={e => setRepeatCount(e.target.value)}
                    placeholder="Infinite"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>End date (optional)</Label>
                  <DateTimePicker date={endDate} setDate={setEndDate} />
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="auto-close-conveyor"
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  checked={autoClose}
                  onChange={e => setAutoClose(e.target.checked)}
                />
                <Label htmlFor="auto-close-conveyor" className="font-normal cursor-pointer">
                  Auto-close after first response
                </Label>
              </div>

            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { resetForm(); setShowCompose(false) }}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating || !subject || !taskBody}>
                {creating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Create Conveyor
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editConveyor} onOpenChange={(open) => { if (!open) setEditConveyor(null) }}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Edit Conveyor</DialogTitle>
            <DialogDescription>Update the recurring task details.</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveEdit}>
            <div className="grid gap-4 py-4">

              {/* Agent */}
              <div className="grid gap-2">
                <Label>Agent</Label>
                <Select value={editAgentId} onValueChange={(v) => { setEditAgentId(v); setEditAgentError(false) }}>
                  <SelectTrigger className={editAgentError ? 'border-destructive' : ''}>
                    <SelectValue placeholder="Select agent…" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map(a => (
                      <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {editAgentError && <p className="text-xs text-destructive">Please select an agent.</p>}
              </div>

              {/* Subject */}
              <div className="grid gap-2">
                <Label>Subject</Label>
                <Input
                  value={editSubject}
                  onChange={e => setEditSubject(e.target.value)}
                  placeholder="Task subject"
                  required
                />
              </div>

              {/* Body */}
              <div className="grid gap-2">
                <Label>Description</Label>
                <Textarea
                  value={editBody}
                  onChange={e => setEditBody(e.target.value)}
                  placeholder="Task description"
                  rows={3}
                  className="font-mono text-sm"
                  required
                />
              </div>

              {/* Frequency + Time */}
              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-2">
                  <Label>Repeat</Label>
                  <Select value={editFrequency} onValueChange={(v: any) => setEditFrequency(v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hourly">Hourly</SelectItem>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label className={editFrequency === 'hourly' ? 'opacity-50' : ''}>Hour</Label>
                  <Select value={editHour} onValueChange={setEditHour} disabled={editFrequency === 'hourly'}>
                    <SelectTrigger className={editFrequency === 'hourly' ? 'opacity-50' : ''}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 24 }).map((_, i) => (
                        <SelectItem key={i} value={i.toString()}>{i.toString().padStart(2, '0')}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>Minute</Label>
                  <Select value={editMinute} onValueChange={setEditMinute}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                        <SelectItem key={m} value={m.toString()}>{m.toString().padStart(2, '0')}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Day of week (weekly) */}
              {editFrequency === 'weekly' && (
                <div className="grid gap-2">
                  <Label>On</Label>
                  <Select value={editDayOfWeek} onValueChange={setEditDayOfWeek}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Sunday</SelectItem>
                      <SelectItem value="1">Monday</SelectItem>
                      <SelectItem value="2">Tuesday</SelectItem>
                      <SelectItem value="3">Wednesday</SelectItem>
                      <SelectItem value="4">Thursday</SelectItem>
                      <SelectItem value="5">Friday</SelectItem>
                      <SelectItem value="6">Saturday</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Day of month (monthly) */}
              {editFrequency === 'monthly' && (
                <div className="grid gap-2">
                  <Label>Day of month</Label>
                  <Select value={editDayOfMonth} onValueChange={setEditDayOfMonth}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 31 }).map((_, i) => (
                        <SelectItem key={i + 1} value={(i + 1).toString()}>{i + 1}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Stop conditions */}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>Max runs (empty = ∞)</Label>
                  <Input
                    type="number"
                    min="1"
                    value={editRepeatCount}
                    onChange={e => setEditRepeatCount(e.target.value)}
                    placeholder="Infinite"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>End date (optional)</Label>
                  <DateTimePicker date={editEndDate} setDate={setEditEndDate} />
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="edit-auto-close-conveyor"
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  checked={editAutoClose}
                  onChange={e => setEditAutoClose(e.target.checked)}
                />
                <Label htmlFor="edit-auto-close-conveyor" className="font-normal cursor-pointer">
                  Auto-close after first response
                </Label>
              </div>

            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditConveyor(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !editSubject || !editBody}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save Changes
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
        ) : conveyors.length === 0 ? (
          <div className="py-12 text-center border-2 border-dashed rounded-lg bg-muted/30">
            <Repeat className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-muted-foreground">No recurring tasks yet.</p>
          </div>
        ) : (
          conveyors.map(c => (
            <Card key={c.id} className={c.paused ? 'opacity-60' : ''}>
              <CardContent className="p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate flex items-center gap-2">
                    {c.subject}
                    {c.paused && (
                      <span className="text-xs font-normal px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        Paused
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground flex items-center gap-2 mt-1">
                    <Repeat className="h-3 w-3" />
                    {formatSchedule(c)}
                    <span>·</span>
                    <Bot className="h-3 w-3" />
                    {agentMap[c.agent_id]?.name ?? c.agent_id}
                  </div>
                  <div className="text-xs text-muted-foreground mt-2 flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      Next: {c.paused ? '—' : new Date(c.next_run_at).toLocaleString()}
                    </span>
                    <span className="flex items-center gap-1">
                      <RefreshCw className="h-3 w-3" />
                      {formatCycles(c)}
                    </span>
                    {c.end_date && (
                      <span className="flex items-center gap-1">
                        Until: {new Date(c.end_date).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleTogglePause(c)}
                    title={c.paused ? 'Resume' : 'Pause'}
                  >
                    {c.paused
                      ? <Play className="h-4 w-4 text-muted-foreground" />
                      : <Pause className="h-4 w-4 text-muted-foreground" />
                    }
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => openEdit(c)} title="Edit">
                    <Pencil className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon">
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete Conveyor</AlertDialogTitle>
                        <AlertDialogDescription>
                          Are you sure you want to delete this recurring task? It will no longer be scheduled.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleDelete(c.id)}
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

import { useState, useEffect, useCallback, useMemo } from 'react'
import { api, type Agent, type Conveyor } from '../lib/api'
import { trackEvent } from '../lib/analytics'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
  Copy,
  Repeat,
  Calendar,
  Bot,
  Loader2,
} from 'lucide-react'

export function Conveyors({ teamId }: { teamId: string }) {
  const [conveyors, setConveyors] = useState<Conveyor[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [showCompose, setShowCompose] = useState(false)
  const [subject, setSubject] = useState('')
  const [taskBody, setTaskBody] = useState('')
  const [agentId, setAgentId] = useState<string | undefined>(undefined)
  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>('daily')
  const [hour, setHour] = useState('9')
  const [minute, setMinute] = useState('0')
  const [dayOfWeek, setDayOfWeek] = useState('1') // Monday
  const [dayOfMonth, setDayOfMonth] = useState('1')
  const [repeatCount, setRepeatCount] = useState('')
  const [endDate, setEndDate] = useState<Date | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [agentError, setAgentError] = useState(false)

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
    setAgentError(false)
  }

  async function handleDelete(id: string) {
    try {
      await api.conveyors.delete(teamId, id)
      trackEvent('conveyor_deleted', { conveyor_id: id })
      load()
    } catch (e) {
      console.error('Failed to delete conveyor:', e)
    }
  }

  function cloneConveyor(c: Conveyor) {
    setSubject(c.subject)
    setTaskBody(c.body)
    setAgentId(c.agent_id)
    setFrequency(c.frequency)
    setHour(c.hour.toString())
    setMinute((c.minute ?? 0).toString())
    setDayOfWeek(c.day_of_week?.toString() ?? '1')
    setDayOfMonth(c.day_of_month?.toString() ?? '1')
    setRepeatCount(c.repeat_count?.toString() ?? '')
    setEndDate(c.end_date ? new Date(c.end_date) : undefined)
    setAgentError(false)
    setShowCompose(true)
  }

  const agentMap = useMemo(() => Object.fromEntries(agents.map(a => [a.id, a])), [agents])

  function formatSchedule(c: Conveyor) {
    const hh = c.hour.toString().padStart(2, '0')
    const mm = (c.minute ?? 0).toString().padStart(2, '0')
    const time = `${hh}:${mm}`
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
        </div>
        <Button onClick={() => setShowCompose(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Conveyor
        </Button>
      </div>

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
                <Textarea
                  id="body"
                  value={taskBody}
                  onChange={e => setTaskBody(e.target.value)}
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
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>Hour</Label>
                  <Select value={hour} onValueChange={setHour}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
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
            <Card key={c.id}>
              <CardContent className="p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{c.subject}</div>
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
                      Next: {new Date(c.next_run_at).toLocaleString()}
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
                  <Button variant="ghost" size="icon" onClick={() => cloneConveyor(c)} title="Clone for edit">
                    <Copy className="h-4 w-4 text-muted-foreground" />
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

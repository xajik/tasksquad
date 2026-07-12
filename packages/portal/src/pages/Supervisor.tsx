import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldAlert, Play, ChevronDown, ChevronRight, RefreshCw, ExternalLink } from 'lucide-react'
import { api, type Task, type Message } from '../lib/api'
import { Button } from '../components/ui/button'

const DAEMON_HOOKS_URL = (import.meta.env.VITE_DAEMON_HOOKS_URL as string | undefined) ?? 'http://localhost:7374'

const ACTIVE_STATUSES = new Set(['running', 'waiting_input', 'wrapping_up'])

interface ParsedVerdict {
  summary: string
  status: string
  found: string
  action: string
  raw?: string
}

function parseVerdictBody(body: string): ParsedVerdict {
  const summaryMatch = body.match(/\[Supervisor\]\s*(.+)/)
  const statusMatch = body.match(/\nStatus:\s*(.+)/)
  const foundMatch = body.match(/\nFound:\s*([\s\S]+?)(?:\nAction:|$)/)
  const actionMatch = body.match(/\nAction:\s*([\s\S]+)/)
  const summary = summaryMatch?.[1]?.trim() ?? ''
  const status = statusMatch?.[1]?.trim() ?? ''
  const found = foundMatch?.[1]?.trim() ?? ''
  const action = actionMatch?.[1]?.trim() ?? ''
  if (!summary && !status && !found && !action) {
    return { summary: '', status: '', found: '', action: '', raw: body }
  }
  return { summary, status, found, action }
}

function verdictColor(status: string) {
  if (status === 'resolved') return 'text-green-600'
  if (status === 'cannot_help') return 'text-red-500'
  if (status === 'working_fine') return 'text-blue-600'
  return 'text-amber-600'
}

function verdictLabel(status: string) {
  if (status === 'resolved') return 'resolved'
  if (status === 'cannot_help') return 'cannot help'
  if (status === 'working_fine') return 'working fine'
  return status
}

function statusBadgeColor(status: string) {
  if (status === 'running') return 'bg-green-100 text-green-700 border-green-200'
  if (status === 'waiting_input') return 'bg-blue-100 text-blue-700 border-blue-200'
  if (status === 'wrapping_up') return 'bg-amber-100 text-amber-700 border-amber-200'
  return 'bg-muted text-muted-foreground border-border'
}

export function Supervisor({ teamId }: { teamId: string }) {
  const nav = useNavigate()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  // taskId → messages (null = not yet loaded, [] = loaded but empty)
  const [msgCache, setMsgCache] = useState<Record<string, Message[] | null>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [triggering, setTriggering] = useState<string | null>(null)
  const [triggerError, setTriggerError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { tasks: all } = await api.tasks.list(teamId)
      // Tasks with legit supervisor findings (type='report') float to the top, most
      // recent first, so you see what the supervisor actually did without expanding
      // every task. Tasks with no legit runs fall back to created_at DESC.
      setTasks(all.sort((a, b) => {
        const aCount = a.supervisor_report_count ?? 0
        const bCount = b.supervisor_report_count ?? 0
        if (aCount > 0 && bCount === 0) return -1
        if (aCount === 0 && bCount > 0) return 1
        if (aCount > 0 && bCount > 0) return (b.last_supervisor_at ?? 0) - (a.last_supervisor_at ?? 0)
        return b.created_at - a.created_at
      }))
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => { load() }, [load])

  async function expandTask(taskId: string) {
    if (expanded === taskId) { setExpanded(null); return }
    setExpanded(taskId)
    if (msgCache[taskId] !== undefined) return
    // Mark as loading
    setMsgCache(c => ({ ...c, [taskId]: null }))
    try {
      const { messages } = await api.messages.list(taskId)
      // Cache all supervisor messages (including routine 'progress' pings) so the
      // empty state can distinguish "checked in, nothing to report" from "never ran".
      setMsgCache(c => ({ ...c, [taskId]: messages.filter(m => m.role === 'supervisor') }))
    } catch {
      setMsgCache(c => ({ ...c, [taskId]: [] }))
    }
  }

  async function triggerSupervisor(taskId: string) {
    setTriggering(taskId)
    setTriggerError(null)
    try {
      const res = await fetch(`${DAEMON_HOOKS_URL}/hooks/trigger-supervisor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setTriggerError((data as { error?: string }).error ?? `HTTP ${res.status}`)
      }
    } catch (e) {
      setTriggerError('Could not reach daemon — is it running?')
    } finally {
      setTriggering(null)
    }
  }

  const activeTasks = tasks.filter(t => ACTIVE_STATUSES.has(t.status))

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-amber-600" />
          <h1 className="text-xl font-semibold">Supervisor</h1>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Reload
        </Button>
      </div>

      {/* Run manually */}
      {activeTasks.length > 0 && (
        <section>
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
            Run manually
          </h2>
          <div className="rounded-lg border border-border divide-y divide-border">
            {activeTasks.map(task => (
              <div key={task.id} className="flex items-center gap-3 px-3 py-2.5">
                <span
                  className="text-sm flex-1 truncate cursor-pointer hover:underline"
                  onClick={() => nav(`/dashboard/tasks/${task.id}`)}
                >
                  {task.subject}
                </span>
                <span className={`text-[10px] font-medium border rounded px-1.5 py-0.5 uppercase tracking-wider shrink-0 ${statusBadgeColor(task.status)}`}>
                  {task.status.replace('_', ' ')}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 h-7 text-xs"
                  disabled={triggering === task.id}
                  onClick={() => triggerSupervisor(task.id)}
                >
                  <Play className="h-3 w-3 mr-1" />
                  {triggering === task.id ? 'Starting…' : 'Run'}
                </Button>
              </div>
            ))}
          </div>
          {triggerError && (
            <p className="text-xs text-red-500 mt-2">{triggerError}</p>
          )}
        </section>
      )}

      {/* Session history */}
      <section>
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
          Session history
        </h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks yet.</p>
        ) : (
          <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
            {tasks.map(task => {
              const isOpen = expanded === task.id
              const rawMsgs = msgCache[task.id]
              const allSupMsgs = rawMsgs ?? []
              // Legit runs = actual findings/escalations. Routine 'working_fine' check-ins
              // (type='progress') are noise and excluded from the list and the count.
              const supMsgs = allSupMsgs.filter(m => m.type === 'report')
              const hasLoaded = rawMsgs !== undefined && rawMsgs !== null
              const isLoading = rawMsgs === null
              const checkedInOnly = hasLoaded && supMsgs.length === 0 && allSupMsgs.length > 0
              const runCount = task.supervisor_report_count ?? (hasLoaded ? supMsgs.length : 0)

              return (
                <div key={task.id}>
                  <button
                    className="flex items-center gap-2 w-full px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
                    onClick={() => expandTask(task.id)}
                  >
                    {isOpen
                      ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                    <span className="text-sm flex-1 truncate">{task.subject}</span>
                    {runCount > 0 && (
                      <span className="text-[10px] font-medium text-amber-600 shrink-0">
                        {runCount} run{runCount !== 1 ? 's' : ''}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground shrink-0 ml-1">
                      {new Date(task.created_at).toLocaleDateString()}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-border bg-muted/20 px-4 py-3 space-y-3">
                      {isLoading && (
                        <p className="text-xs text-muted-foreground">Loading…</p>
                      )}
                      {hasLoaded && supMsgs.length === 0 && !checkedInOnly && (
                        <p className="text-xs text-muted-foreground">No supervisor runs for this task.</p>
                      )}
                      {checkedInOnly && (
                        <p className="text-xs text-muted-foreground">Supervisor checked in — task looked fine, nothing to report.</p>
                      )}
                      {supMsgs.map(msg => {
                        const v = parseVerdictBody(msg.body)
                        return (
                          <div key={msg.id} className="rounded-md border border-border bg-background p-3 space-y-1.5">
                            <div className="flex items-center gap-2">
                              <ShieldAlert className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                              {!v.raw && (
                                <span className={`text-[10px] uppercase tracking-wider font-semibold shrink-0 ${verdictColor(v.status)}`}>
                                  {verdictLabel(v.status)}
                                </span>
                              )}
                              <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                                {new Date(msg.created_at).toLocaleString()}
                              </span>
                            </div>
                            {v.raw ? (
                              <pre className="text-xs text-foreground/80 whitespace-pre-wrap break-words">{v.raw}</pre>
                            ) : (
                              <>
                                {v.summary && (
                                  <p className="text-xs text-foreground/80">{v.summary}</p>
                                )}
                                {v.found && (
                                  <div className="text-xs">
                                    <span className="text-muted-foreground font-medium">Found: </span>
                                    <span className="text-foreground/80">{v.found}</span>
                                  </div>
                                )}
                                {v.action && (
                                  <div className="text-xs">
                                    <span className="text-muted-foreground font-medium">Action: </span>
                                    <span className="text-foreground/80">{v.action}</span>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )
                      })}
                      <button
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => nav(`/dashboard/tasks/${task.id}`)}
                      >
                        <ExternalLink className="h-3 w-3" />
                        Open task thread
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

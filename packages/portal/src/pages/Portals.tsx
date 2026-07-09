import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate, useParams, Routes, Route } from 'react-router-dom'
import { api, type Portal, type Agent } from '../lib/api'
import { trackEvent } from '../lib/analytics'
import { relativeTime } from '../lib/utils'
import { LiveTerminal } from '../components/LiveTerminal'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import {
  ArrowLeft,
  Loader2,
  Monitor,
  Plus,
  Trash2,
  Zap,
} from 'lucide-react'

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  running: 'Live',
  closing: 'Closing…',
  done: 'Done',
  failed: 'Failed',
}

function PortalStatusBadge({ status }: { status: string }) {
  const map: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    pending: 'outline',
    running: 'default',
    closing: 'secondary',
    done:    'default',
    failed:  'destructive',
  }
  return (
    <Badge variant={map[status] ?? 'outline'}>
      {status === 'running' && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
      {STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

function isActiveStatus(s: string) {
  return s === 'pending' || s === 'running'
}

// ── Portal list ───────────────────────────────────────────────────────────────

function PortalsList({ teamId, plan }: { teamId: string; plan: 'free' | 'pro' }) {
  const nav = useNavigate()
  const [portals, setPortals] = useState<Portal[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [showCompose, setShowCompose] = useState(false)
  const [agentId, setAgentId] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [pd, ad] = await Promise.all([api.portals.list(teamId), api.agents.list(teamId)])
    setPortals(pd.portals ?? [])
    setAgents(ad.agents ?? [])
    setLoading(false)
  }, [teamId])

  useEffect(() => { load() }, [load])

  // Poll while any portal is active (pending or running)
  useEffect(() => {
    const hasActive = portals.some(p => isActiveStatus(p.status))
    if (!hasActive) return
    const id = setInterval(load, 3000)
    return () => clearInterval(id)
  }, [portals, load])

  const agentMap = useMemo(() => Object.fromEntries(agents.map(a => [a.id, a])), [agents])
  const activeAgents = useMemo(() => agents.filter(a => a.status === 'active' || a.status === 'idle'), [agents])
  const livePortals = useMemo(() => portals.filter(p => isActiveStatus(p.status)), [portals])
  const atLimit = livePortals.length >= 3

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!agentId) return
    setCreating(true)
    setCreateError(null)
    try {
      const { id } = await api.portals.create({ team_id: teamId, agent_id: agentId })
      trackEvent('portal_created', { team_id: teamId, agent_id: agentId })
      setShowCompose(false)
      setAgentId('')
      nav(`portals/${id}`)
    } catch (e: any) {
      const code = e?.error
      if (code === 'plan_required') setCreateError('Portals require a Pro plan.')
      else if (code === 'portal_limit_reached') setCreateError('Team limit of 3 live portals reached.')
      else setCreateError('Failed to create portal. Please try again.')
    } finally { setCreating(false) }
  }

  async function handleClosePortal(portalId: string) {
    try {
      await api.portals.close(portalId)
      load()
    } catch { /* ignore */ }
  }

  // Free user — show upgrade wall
  if (!loading && plan === 'free') {
    return (
      <div className="animate-fade-in w-full">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Portals</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Live terminal sessions streamed to the browser</p>
          </div>
        </div>
        <div className="flex flex-col items-center justify-center py-20 text-center gap-4">
          <div className="rounded-full bg-primary/10 p-4">
            <Monitor className="h-8 w-8 text-primary" />
          </div>
          <div>
            <p className="font-semibold text-lg">Portals require a Pro plan</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-xs">
              Stream live terminal sessions directly to your browser. Watch your agents work in real time.
            </p>
          </div>
          <Button
            onClick={() => {
              trackEvent('upgrade_clicked', { source: 'portals_gate' })
              nav('/pricing')
            }}
          >
            <Zap className="h-4 w-4 mr-1.5" />
            Upgrade to Pro
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="animate-fade-in w-full">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Portals</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Live terminal sessions streamed to the browser</p>
        </div>
        <Button onClick={() => setShowCompose(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          New portal
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : portals.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
          <Monitor className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-muted-foreground text-sm">No portals yet. Create one to stream a live terminal session.</p>
          <Button variant="outline" size="sm" onClick={() => setShowCompose(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New portal
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {portals.map(p => (
            <Card
              key={p.id}
              className="cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => nav(`portals/${p.id}`)}
            >
              <CardContent className="p-3 sm:p-4 flex items-center gap-3">
                <Monitor className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{agentMap[p.agent_id]?.name ?? p.agent_id}</div>
                  <div className="text-xs text-muted-foreground">{relativeTime(p.created_at)}</div>
                </div>
                <PortalStatusBadge status={p.status} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* New portal compose dialog */}
      <Dialog open={showCompose} onOpenChange={open => { setShowCompose(open); if (!open) setCreateError(null) }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>New portal</DialogTitle>
            <DialogDescription>
              Select a harness to open a live terminal session in the browser.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate}>
            <div className="grid gap-4 py-4">
              {atLimit ? (
                // Limit reached — show live portals with close buttons
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Team limit of 3 live portals reached. Close one to continue.
                  </p>
                  <div className="space-y-2">
                    {livePortals.map(p => (
                      <div key={p.id} className="flex items-center justify-between text-sm px-1">
                        <span className="font-medium truncate flex-1 mr-2">{agentMap[p.agent_id]?.name ?? p.agent_id}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          <PortalStatusBadge status={p.status} />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => handleClosePortal(p.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="grid gap-2">
                  <Label>Harness</Label>
                  <Select value={agentId} onValueChange={setAgentId} required>
                    <SelectTrigger>
                      <SelectValue placeholder="Select harness…" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeAgents.length === 0 ? (
                        <SelectItem value="__none__" disabled>No active harnesses</SelectItem>
                      ) : (
                        activeAgents.map(a => (
                          <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {createError && (
                <p className="text-sm text-destructive">{createError}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCompose(false)}>
                Cancel
              </Button>
              {!atLimit && (
                <Button type="submit" disabled={!agentId || creating}>
                  {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Monitor className="h-3.5 w-3.5 mr-1.5" />}
                  Open portal
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Portal detail ─────────────────────────────────────────────────────────────

function PortalDetail({ teamId }: { teamId: string; plan: 'free' | 'pro' }) {
  const { portalId } = useParams<{ portalId: string }>()
  const nav = useNavigate()
  const [portal, setPortal] = useState<Portal | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])

  const load = useCallback(async () => {
    if (!portalId) return
    const [p, ad] = await Promise.all([api.portals.get(portalId), api.agents.list(teamId)])
    setPortal(p)
    setAgents(ad.agents ?? [])
  }, [portalId, teamId])

  useEffect(() => { load() }, [load])

  // Poll while pending or running
  useEffect(() => {
    if (!portal) return
    if (!isActiveStatus(portal.status)) return
    const id = setInterval(load, 2000)
    return () => clearInterval(id)
  }, [portal?.status, load])

  const agentName = useMemo(() => {
    if (!portal) return 'Harness'
    return agents.find(a => a.id === portal.agent_id)?.name ?? 'Harness'
  }, [portal, agents])

  if (!portal) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="animate-fade-in w-full">
      {/* Header */}
      <div className="flex items-start gap-2 mb-6 pb-5 border-b border-border/50">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => nav('/dashboard/portals')}
          className="shrink-0 mt-0.5 -ml-2"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight leading-snug">
            {agentName}
          </h1>
          <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground flex-wrap">
            <PortalStatusBadge status={portal.status} />
            <span>{relativeTime(portal.created_at)}</span>
          </div>
        </div>
      </div>

      {/* Pending state — waiting for daemon to connect */}
      {portal.status === 'pending' && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/50" />
          <p className="text-muted-foreground text-sm">
            Waiting for <span className="font-medium text-foreground">{agentName}</span> to connect…
          </p>
          <p className="text-xs text-muted-foreground/60">
            The daemon will pick this up on its next heartbeat and open a terminal session.
          </p>
        </div>
      )}

      {/* Live terminal — shown while daemon session is active */}
      {portal.status === 'running' && portal.session_id && (
        <div className="mb-6 flex flex-col" style={{ height: 'calc(100vh - 320px)', minHeight: 300 }}>
          <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground flex-shrink-0">
            <Monitor className="h-3.5 w-3.5" />
            <span>Live terminal · session {portal.session_id.slice(0, 8)}</span>
          </div>
          <div className="flex-1 min-h-0">
            <LiveTerminal sessionId={portal.session_id} />
          </div>
        </div>
      )}

      {/* Running but session_id not yet set — brief transition state */}
      {portal.status === 'running' && !portal.session_id && (
        <div className="flex items-center gap-2 py-10 justify-center text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Starting terminal…</span>
        </div>
      )}

      {/* Done/failed state — show message thread */}
      {(portal.status === 'done' || portal.status === 'failed') && (
        <>
          <div className="mb-4 px-3 py-2 rounded-lg bg-muted/50 text-xs text-muted-foreground flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Monitor className="h-3.5 w-3.5 shrink-0" />
              <span>Session {portal.status === 'done' ? 'completed' : 'failed'} · {portal.completed_at ? relativeTime(portal.completed_at) : ''}</span>
            </div>
            {portal.status === 'failed' && (
              <Button variant="outline" size="sm" onClick={() => nav('/dashboard/portals')}>
                Open new portal
              </Button>
            )}
          </div>

        </>
      )}
    </div>
  )
}

// ── Router entry point ────────────────────────────────────────────────────────

export function Portals({ teamId, plan }: { teamId: string; plan: 'free' | 'pro' }) {
  return (
    <Routes>
      <Route path="/" element={<PortalsList teamId={teamId} plan={plan} />} />
      <Route path="portals/:portalId" element={<PortalDetail teamId={teamId} plan={plan} />} />
    </Routes>
  )
}

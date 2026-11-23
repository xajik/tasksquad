import { useEffect, useMemo, useRef, useState } from 'react'
import { Network } from 'lucide-react'
import { effectiveRole, type GraphSnapshot } from '@/lib/graph'
import {
  fallbackLabel,
  isGuidance,
  layoutGraph,
  projectionRoute,
  resolveCollisions,
  type Point
} from '@/lib/graphLayout'
import { Button } from './ui/button'
import { goalProjection } from '@/lib/graphProjection'
import { graphAttention } from '@/lib/graphAttention'

/** Guidance and execution share a canvas, with distinct styling and relationships. */
export function GraphCanvas({
  graph,
  selected,
  onSelect,
  search,
  matchedIds
}: {
  graph: GraphSnapshot
  selected: string | null
  onSelect: (id: string) => void
  search: string
  matchedIds?: string[]
}) {
  const [zoom, setZoom] = useState(1),
    [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; origin: { x: number; y: number } } | null>(null)
  const nodeDrag = useRef<{ id: string; x: number; y: number; origin: Point; moved: boolean } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  // Manual placement survives polling and reloads; Regroup discards it.
  const storageKey = `graph-layout:${graph.id}`
  const [manual, setManual] = useState<Record<string, Point>>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    } catch {
      return {}
    }
  })
  function saveManual(next: Record<string, Point>) {
    setManual(next)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      /* storage unavailable: placement lasts for this view only */
    }
  }
  const attention = graphAttention(graph)
  const nodes = graph.nodes
  const ids = new Set(nodes.map((n) => n.id))
  const links = [
    ...graph.edges.filter(
      (e) =>
        ids.has(e.from_id) &&
        ids.has(e.to_id) &&
        !isGuidance(nodes.find((n) => n.id === e.from_id)!) &&
        !isGuidance(nodes.find((n) => n.id === e.to_id)!)
    ),
    ...nodes
      .filter(
        (n) =>
          n.parent_id &&
          ids.has(n.parent_id) &&
          isGuidance(n) === isGuidance(nodes.find((parent) => parent.id === n.parent_id)!) &&
          !graph.edges.some((e) => e.from_id === n.parent_id && e.to_id === n.id)
      )
      .map((n) => ({
        id: `lineage-${n.id}`,
        from_id: n.parent_id!,
        to_id: n.id,
        lineage: true,
        guidance: isGuidance(n)
      }))
  ]
  // Polling updates titles, reviews and scores without moving the viewport.
  const topology = JSON.stringify({
    nodes: nodes
      .map(({ id, kind, created_at }) => ({ id, kind, created_at }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: links
      .map((e) => ({ id: e.id, from_id: e.from_id, to_id: e.to_id, lineage: 'lineage' in e }))
      .sort((a, b) => a.id.localeCompare(b.id))
  })
  const layout = useMemo(() => {
    const data = JSON.parse(topology)
    return layoutGraph(data.nodes, data.edges, true, new Map(Object.entries(manual)))
  }, [topology, manual])
  const [live, setLive] = useState<{ id: string; at: Point } | null>(null)
  const shown = (id: string) => (live?.id === id ? live.at : (layout.positions.get(id) as Point))
  const selectedExecution = nodes.find((n) => n.id === selected && !isGuidance(n))
  const projection = selectedExecution ? goalProjection(graph, selectedExecution.id) : null
  const projectionLabel = projection?.evaluated
    ? projection.score === null
      ? 'Alignment unknown'
      : `Goal alignment ${projection.score.toFixed(2)}`
    : 'Not evaluated'
  // Root goal plus the milestones decompose derived from it: execution projects towards every active one.
  const goalLabel = (goalId: string) => {
    const impact = projection?.impacts.get(goalId)
    return impact === undefined ? projectionLabel : impact === null ? 'Alignment unknown' : `Goal alignment ${impact.toFixed(2)}`
  }
  const goals = nodes.filter((n) => isGuidance(n) && n.state !== 'deactivated')
  const projectionPaths = selectedExecution
    ? goals.map((goal) => ({ goal, points: projectionRoute(layout, selectedExecution.id, goal.id) }))
    : []
  function fit() {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }
  function regroup() {
    saveManual({})
    fit()
  }
  useEffect(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [graph.id, topology])
  // Excalidraw-style: wheel pans, Ctrl/⌘+wheel (or pinch) zooms towards the pointer.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const scale = Math.max(layout.bounds.width / rect.width, layout.bounds.height / rect.height)
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01)
        setZoom((z) => {
          const next = Math.min(6, Math.max(0.3, z * factor))
          const px = (e.clientX - rect.left) * scale + layout.bounds.x,
            py = (e.clientY - rect.top) * scale + layout.bounds.y
          setOffset((o) => ({
            x: px - ((px - o.x) / z) * next,
            y: py - ((py - o.y) / z) * next
          }))
          return next
        })
      } else setOffset((o) => ({ x: o.x - e.deltaX * scale, y: o.y - e.deltaY * scale }))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [layout.bounds.width, layout.bounds.height, layout.bounds.x, layout.bounds.y])
  // Backward propagation: evidence flows from the selected result back along its executed lineage.
  const backedUp = useMemo(() => {
    const path: string[] = []
    if (!selectedExecution) return path
    let cursor = selectedExecution.id
    for (let guard = 0; guard < 64; guard++) {
      // Follow actions first, then result lineage, so credit visibly reaches the observed start.
      const incoming =
        graph.edges.find((e) => e.to_id === cursor) ??
        links.find((l) => 'lineage' in l && !l.guidance && l.to_id === cursor)
      if (!incoming || path.includes(incoming.id)) break
      path.push(incoming.id)
      cursor = incoming.from_id
    }
    return path
  }, [graph.edges, links, selectedExecution])
  const matched = (n: (typeof graph.nodes)[number]) =>
    matchedIds
      ? matchedIds.includes(n.id)
      : !search || `${n.title} ${n.description} ${n.body}`.toLowerCase().includes(search.toLowerCase())
  const observedResults = new Set(
    graph.results
      .filter(
        (r) =>
          r.status === 'accepted' &&
          ['execute', 'undo'].includes(
            effectiveRole(graph, graph.attempts.find((t) => t.id === r.attempt_id)?.assignment_id)
          )
      )
      .map((r) => r.id)
  )
  function score(edge: string) {
    const values = graph.evaluations.filter((e) => e.edge_id === edge && e.local_score !== null)
    return values[values.length - 1]?.local_score?.toFixed(2) ?? '—'
  }
  function inspectKey(event: React.KeyboardEvent, id: string) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(id)
    }
  }
  return (
    <div className="min-w-0 bg-muted/10">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Network className="h-4 w-4" />
            Action graph
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Goals & milestones: right to left · Execution: left to right
          </p>
        </div>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}
          >
            −
          </Button>
          <Button variant="ghost" size="sm" onClick={fit}>
            Fit
          </Button>
          <Button variant="ghost" size="sm" aria-label="Regroup graph" onClick={regroup}>
            Regroup
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(6, z + 0.2))}
          >
            +
          </Button>
        </div>
      </div>
      {selectedExecution && (
        <div
          role="status"
          aria-label="Goal projection"
          className="border-b px-4 py-2 text-xs flex flex-wrap gap-x-3 gap-y-1 bg-blue-500/5"
        >
          <span className="font-medium text-blue-600 dark:text-blue-400">
            {selectedExecution.title} → {goals.map((g) => g.title).join(', ') || 'Goal'}
          </span>
          <span>{projectionLabel}</span>
          {projection?.evaluated && (
            <span className="text-muted-foreground">
              Latest accepted projection · goal verification is separate
            </span>
          )}
        </div>
      )}
      <svg
        ref={svgRef}
        aria-label="Action graph: guidance, execution states and actions"
        role="group"
        viewBox={`${layout.bounds.x} ${layout.bounds.y} ${layout.bounds.width} ${layout.bounds.height}`}
        className="w-full min-h-80 max-h-[650px] touch-none cursor-grab"
        onPointerDown={(e) => {
          if ((e.target as Element).closest('[data-entity]')) return
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* see node drag */
          }
          drag.current = { x: e.clientX, y: e.clientY, origin: offset }
        }}
        onPointerMove={(e) => {
          const nd = nodeDrag.current
          if (nd) {
            const r = e.currentTarget.getBoundingClientRect()
            const k = Math.max(layout.bounds.width / r.width, layout.bounds.height / r.height) / zoom
            const dx = (e.clientX - nd.x) * k,
              dy = (e.clientY - nd.y) * k
            if (Math.abs(dx) + Math.abs(dy) > 3 / zoom) nd.moved = true
            if (nd.moved) setLive({ id: nd.id, at: { x: nd.origin.x + dx, y: nd.origin.y + dy } })
            return
          }
          if (!drag.current) return
          const rect = e.currentTarget.getBoundingClientRect()
          const scale = Math.max(layout.bounds.width / rect.width, layout.bounds.height / rect.height)
          setOffset({
            x: drag.current.origin.x + (e.clientX - drag.current.x) * scale,
            y: drag.current.origin.y + (e.clientY - drag.current.y) * scale
          })
        }}
        onPointerUp={() => {
          const nd = nodeDrag.current
          nodeDrag.current = null
          // The svg holds pointer capture during a card press, so the browser delivers the click to the
          // svg instead of the card. Selecting here (when the card was not dragged) is what makes cards clickable.
          if (nd && !nd.moved) onSelect(nd.id)
          if (nd?.moved && live?.id === nd.id) {
            // Drop resolves collisions, then routing re-runs around the new placement.
            saveManual({ ...manual, [nd.id]: resolveCollisions(layout.positions, nd.id, live.at) })
          }
          setLive(null)
          drag.current = null
        }}
        onPointerCancel={() => {
          nodeDrag.current = null
          setLive(null)
          drag.current = null
        }}
      >
        <title>{graph.title} — goals, milestones, execution states and actions</title>
        <desc>
          Dashed goal and milestone cards provide planning guidance; solid state cards participate in
          execution. Use Tab and Enter to inspect states and actions. Drag cards to rearrange (overlaps are resolved on drop), drag the background or scroll to pan, and hold Ctrl or Command while scrolling to zoom. New states
          trigger automatic regrouping and collision-aware routing.
        </desc>
        <defs>
          <marker
            id="graph-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10Z" className="fill-muted-foreground" />
          </marker>
          <marker
            id="graph-projection-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10Z" className="fill-blue-500 dark:fill-blue-400" />
          </marker>
        </defs>
        <g transform={`translate(${offset.x} ${offset.y}) scale(${zoom})`}>
          {links.map((link) => {
            const geometry = layout.edges.get(link.id)
            if (!geometry) return null
            const lineage = 'lineage' in link
            const guidance = 'guidance' in link && link.guidance
            const edge = graph.edges.find((e) => e.id === link.id)
            const id = lineage ? link.to_id : link.id
            const path = geometry.points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')
            return (
              <g
                key={link.id}
                data-entity={id}
                data-edge={link.id}
                role="button"
                tabIndex={0}
                aria-label={
                  lineage
                    ? guidance
                      ? 'Inspect planning hierarchy'
                      : 'Inspect observed result lineage'
                    : `Inspect action ${edge!.title}, expected ${edge!.expected_score?.toFixed(2) ?? 'unknown'}, observed ${score(link.id)}`
                }
                onClick={() => onSelect(id)}
                onKeyDown={(e) => inspectKey(e, id)}
                className="cursor-pointer"
              >
                <path
                  d={path}
                  fill="none"
                  className={
                    backedUp.includes(link.id)
                      ? 'stroke-emerald-600 dark:stroke-emerald-400'
                      : selected === id
                        ? 'stroke-primary'
                        : lineage
                          ? 'stroke-border'
                          : 'stroke-muted-foreground'
                  }
                  strokeWidth={selected === id || backedUp.includes(link.id) ? 2.5 : 1.5}
                  strokeDasharray={lineage ? '5 4' : undefined}
                  markerEnd={guidance || !lineage ? 'url(#graph-arrow)' : undefined}
                  strokeLinejoin="round"
                />
                <path d={path} fill="none" stroke="transparent" strokeWidth={14} />
                <title>
                  {lineage
                    ? guidance
                      ? 'Planning guidance hierarchy'
                      : 'Observed result lineage'
                    : `${edge!.title} · expected ${edge!.expected_score?.toFixed(2) ?? 'unknown'} · observed ${score(link.id)}`}
                </title>
                {edge && (() => {
                  const label = geometry.label ?? fallbackLabel(geometry.points)
                  if (!label) return null
                  const up = backedUp.includes(link.id)
                  return (
                    <g data-edge-label={link.id} data-backed-up={up ? 'true' : undefined}>
                      <rect
                        {...label}
                        rx={5}
                        className={`fill-background ${up ? 'stroke-emerald-600 dark:stroke-emerald-400' : 'stroke-border'}`}
                      />
                      <text
                        x={label.x + label.width / 2}
                        y={label.y + 15}
                        textAnchor="middle"
                        className={`text-[11px] ${up ? 'fill-emerald-700 dark:fill-emerald-400 font-medium' : 'fill-muted-foreground'}`}
                      >
                        {up ? '↩ ' : ''}
                        {edge.expected_score?.toFixed(2) ?? '—'} → {score(link.id)}
                      </text>
                    </g>
                  )
                })()}
              </g>
            )
          })}
          {projectionPaths.map(({ goal, points }) => (
            <g
              key={`projection-${goal.id}`}
              data-projection-source={selectedExecution!.id}
              data-projection-goal={goal.id}
              role="img"
              aria-label={`Projection towards ${goal.title}: ${goalLabel(goal.id)}`}
              className="pointer-events-none"
            >
              <path
                d={points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')}
                fill="none"
                className="stroke-blue-500 dark:stroke-blue-400"
                strokeWidth={2.5}
                strokeDasharray="9 4 2 4"
                strokeLinejoin="round"
                markerEnd="url(#graph-projection-arrow)"
              />
            </g>
          ))}
          {nodes.map((n) => {
            const box = layout.positions.get(n.id)!
            const at = shown(n.id)
            const p = { ...box, x: at.x, y: at.y }
            const observed =
              n.kind === 'observed' || (n.source_result_id && observedResults.has(n.source_result_id))
            const guidance = isGuidance(n)
            const needsAttention = attention.nodes.get(n.id)?.[0]
            const projectedGoal = !!selectedExecution && goals.some((goal) => goal.id === n.id)
            const label = guidance
              ? n.kind === 'goal'
                ? `Goal · guidance · ${graph.goal_verification === 'true' ? 'Verified' : graph.goal_verification === 'false' ? 'Not met' : 'Unverified'}`
                : 'Milestone · guidance'
              : observed
                ? 'Observed state'
                : n.kind === 'restoration'
                  ? 'Restoration'
                  : 'Proposed state'
            return (
              <g
                key={n.id}
                transform={`translate(${p.x},${p.y})`}
                data-entity={n.id}
                data-execution-node={guidance ? undefined : n.id}
                data-guidance={guidance ? n.id : undefined}
                data-attention={needsAttention?.kind}
                data-flow={guidance ? 'rtl' : 'ltr'}
                data-projection-target={projectedGoal ? 'true' : undefined}
                role="button"
                tabIndex={0}
                aria-label={`${n.title}: ${label}${guidance ? '' : `, ${n.state}`}${needsAttention ? `, ${needsAttention.label}` : ''}`}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  try {
                    svgRef.current?.setPointerCapture(e.pointerId)
                  } catch {
                    /* capture is an optimisation; dragging still works without it */
                  }
                  nodeDrag.current = { id: n.id, x: e.clientX, y: e.clientY, origin: { x: at.x, y: at.y }, moved: false }
                }}
                onClick={() => onSelect(n.id)}
                onKeyDown={(e) => inspectKey(e, n.id)}
                className={live?.id === n.id ? 'cursor-grabbing' : 'cursor-grab'}
                opacity={matched(n) ? (n.state === 'deactivated' ? 0.5 : 1) : 0.25}
              >
                <rect
                  width={p.width}
                  height={p.height}
                  rx={8}
                  className={`${needsAttention ? 'stroke-amber-600 dark:stroke-amber-400' : selected === n.id ? 'stroke-primary' : projectedGoal ? 'stroke-blue-500 dark:stroke-blue-400' : guidance ? 'stroke-muted-foreground' : 'stroke-border'} ${needsAttention ? 'fill-amber-500/10' : guidance ? 'fill-secondary/40' : 'fill-background'}`}
                  strokeWidth={selected === n.id ? 2 : 1}
                  strokeDasharray={guidance ? '6 4' : n.state === 'deactivated' ? '1 3' : undefined}
                />
                <text x={14} y={23} className="fill-muted-foreground text-[12px]">
                  {label}
                  {guidance ? '' : ` · ${n.state}`}
                </text>
                <text x={14} y={48} className="fill-foreground text-[14px] font-medium">
                  {n.title.length > 25 ? n.title.slice(0, 24) + '…' : n.title}
                </text>
                {needsAttention && (
                  <a
                    href={needsAttention.taskId ? `/dashboard/tasks/${needsAttention.taskId}` : '/dashboard'}
                    aria-label={`${needsAttention.label}: ${n.title}`}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <rect x={8} y={52} width={204} height={20} fill="transparent" />
                    <text
                      x={14}
                      y={66}
                      className="fill-amber-700 dark:fill-amber-400 text-[12px] font-medium underline"
                    >
                      {needsAttention.label} →
                    </text>
                  </a>
                )}
                <title>{n.title}</title>
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}

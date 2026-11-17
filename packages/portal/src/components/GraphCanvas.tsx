import { useEffect, useMemo, useRef, useState } from 'react'
import { Network } from 'lucide-react'
import type { GraphSnapshot } from '@/lib/graph'
import { isGuidance, layoutGraph, projectionRoute } from '@/lib/graphLayout'
import { Button } from './ui/button'
import { goalProjection } from '@/lib/graphProjection'

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
    return layoutGraph(data.nodes, data.edges, true)
  }, [topology])
  const selectedExecution = nodes.find((n) => n.id === selected && !isGuidance(n))
  const projection = selectedExecution ? goalProjection(graph, selectedExecution.id) : null
  const projectionLabel = projection?.evaluated
    ? projection.score === null
      ? 'Alignment unknown'
      : `Goal alignment ${projection.score.toFixed(2)}`
    : 'Not evaluated'
  const goals = nodes.filter((n) => n.kind === 'goal' && n.state !== 'deactivated')
  const projectionPaths = selectedExecution
    ? goals.map((goal) => ({ goal, points: projectionRoute(layout, selectedExecution.id, goal.id) }))
    : []
  function fit() {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }
  useEffect(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [graph.id, topology])
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
            graph.assignments.find(
              (a) => a.id === graph.attempts.find((t) => t.id === r.attempt_id)?.assignment_id
            )?.role ?? ''
          )
      )
      .map((r) => r.id)
  )
  function score(edge: string) {
    const values = graph.evaluations.filter((e) => e.edge_id === edge && e.local_score !== null)
    return values[values.length - 1]?.local_score?.toFixed(2) ?? 'unknown'
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
          <Button variant="ghost" size="sm" aria-label="Regroup graph" onClick={fit}>
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
        aria-label="Action graph: guidance, execution states and actions"
        role="group"
        viewBox={`${layout.bounds.x} ${layout.bounds.y} ${layout.bounds.width} ${layout.bounds.height}`}
        className="w-full min-h-80 max-h-[650px] touch-none"
        onPointerDown={(e) => {
          if ((e.target as Element).closest('[data-entity]')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, origin: offset }
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          const rect = e.currentTarget.getBoundingClientRect()
          const scale = Math.max(layout.bounds.width / rect.width, layout.bounds.height / rect.height)
          setOffset({
            x: drag.current.origin.x + (e.clientX - drag.current.x) * scale,
            y: drag.current.origin.y + (e.clientY - drag.current.y) * scale
          })
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        <title>{graph.title} — goals, milestones, execution states and actions</title>
        <desc>
          Dashed goal and milestone cards provide planning guidance; solid state cards participate in
          execution. Use Tab and Enter to inspect states and actions. Drag the background to pan. New states
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
                    selected === id ? 'stroke-primary' : lineage ? 'stroke-border' : 'stroke-muted-foreground'
                  }
                  strokeWidth={selected === id ? 2.5 : 1.5}
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
                {geometry.label && edge && (
                  <g data-edge-label={link.id}>
                    <rect {...geometry.label} rx={5} className="fill-background stroke-border" />
                    <text
                      x={geometry.label.x + geometry.label.width / 2}
                      y={geometry.label.y + 15}
                      textAnchor="middle"
                      className="fill-muted-foreground text-[10px]"
                    >
                      {edge.expected_score?.toFixed(2) ?? '?'} → {score(link.id)}
                    </text>
                  </g>
                )}
              </g>
            )
          })}
          {projectionPaths.map(({ goal, points }) => (
            <g
              key={`projection-${goal.id}`}
              data-projection-source={selectedExecution!.id}
              data-projection-goal={goal.id}
              role="img"
              aria-label={`Projection towards ${goal.title}: ${projectionLabel}`}
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
            const p = layout.positions.get(n.id)!
            const observed =
              n.kind === 'observed' || (n.source_result_id && observedResults.has(n.source_result_id))
            const guidance = isGuidance(n)
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
                data-flow={guidance ? 'rtl' : 'ltr'}
                data-projection-target={projectedGoal ? 'true' : undefined}
                role="button"
                tabIndex={0}
                aria-label={`${n.title}: ${label}${guidance ? '' : `, ${n.state}`}`}
                onClick={() => onSelect(n.id)}
                onKeyDown={(e) => inspectKey(e, n.id)}
                className="cursor-pointer"
                opacity={matched(n) ? (n.state === 'deactivated' ? 0.5 : 1) : 0.25}
              >
                <rect
                  width={p.width}
                  height={p.height}
                  rx={8}
                  className={`${selected === n.id ? 'stroke-primary' : projectedGoal ? 'stroke-blue-500 dark:stroke-blue-400' : guidance ? 'stroke-muted-foreground' : 'stroke-border'} ${guidance ? 'fill-secondary/40' : 'fill-background'}`}
                  strokeWidth={selected === n.id ? 2 : 1}
                  strokeDasharray={guidance ? '6 4' : n.state === 'deactivated' ? '1 3' : undefined}
                />
                <text x={14} y={23} className="fill-muted-foreground text-[10px]">
                  {label}
                  {guidance ? '' : ` · ${n.state}`}
                </text>
                <text x={14} y={47} className="fill-foreground text-[12px] font-medium">
                  {n.title.length > 29 ? n.title.slice(0, 28) + '…' : n.title}
                </text>
                <title>{n.title}</title>
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}

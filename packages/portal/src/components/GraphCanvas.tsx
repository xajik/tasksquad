import { useMemo, useRef, useState } from 'react'
import type { GraphSnapshot } from '@/lib/graph'
import { Button } from './ui/button'

/** SVG keeps graph navigation accessible without a large canvas dependency. */
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
  const positions = useMemo(() => {
    const result = new Map<string, { x: number; y: number }>(),
      counts: Record<number, number> = {}
    for (const n of graph.nodes) {
      const lane = n.kind === 'observed' ? 0 : n.kind === 'milestone' ? 1 : n.kind === 'goal' ? 3 : 2
      const row = counts[lane] ?? 0
      counts[lane] = row + 1
      result.set(n.id, { x: 40 + lane * 230, y: 50 + row * 100 + (lane % 2) * 80 })
    }
    return result
  }, [graph.nodes])
  const height = Math.max(400, ...[...positions.values()].map((p) => p.y + 100))
  function score(edge: string) {
    const values = graph.evaluations.filter((e) => e.edge_id === edge)
    const locals = values.filter((e) => e.local_score !== null)
    const latest = locals[locals.length - 1]
    return latest?.local_score?.toFixed(2) ?? 'unknown'
  }
  return (
    <div className="min-w-0 bg-muted/10">
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <span className="text-sm text-muted-foreground">
          Observed context → competing actions → measurable goal
        </span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}
          >
            −
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setZoom(1)
              setOffset({ x: 0, y: 0 })
            }}
          >
            Fit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(2.5, z + 0.2))}
          >
            +
          </Button>
        </div>
      </div>
      <svg
        aria-label="Action graph: select a node or action"
        role="group"
        viewBox={`0 0 950 ${height}`}
        className="w-full min-h-80 max-h-[650px] touch-none"
        onPointerDown={(e) => {
          if ((e.target as Element).closest('[data-entity]')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, origin: offset }
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          const scale = 950 / e.currentTarget.getBoundingClientRect().width
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
        <title>{graph.title}</title>
        <desc>Use Tab and Enter to inspect nodes and actions. Drag the background to pan.</desc>
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
        </defs>
        <g transform={`translate(${offset.x} ${offset.y}) scale(${zoom})`}>
          {graph.nodes
            .filter((n) => n.parent_id && positions.has(n.parent_id))
            .map((n) => {
              const a = positions.get(n.parent_id!)!,
                b = positions.get(n.id)!
              return (
                <path
                  key={`lineage-${n.id}`}
                  d={`M${a.x + 85},${a.y + 62} Q${a.x + 85},${b.y + 85} ${b.x + 85},${b.y + 62}`}
                  fill="none"
                  className="stroke-border"
                  strokeDasharray="4 4"
                >
                  <title>
                    {n.kind === 'milestone' ? 'Goal decomposition hypothesis' : 'Observed lineage'}
                  </title>
                </path>
              )
            })}
          {graph.edges.map((e) => {
            const a = positions.get(e.from_id),
              b = positions.get(e.to_id)
            if (!a || !b) return null
            const path = `M${a.x + 170},${a.y + 25} C${a.x + 220},${a.y + 25} ${b.x - 50},${b.y + 25} ${b.x},${b.y + 25}`
            return (
              <g
                key={e.id}
                data-entity={e.id}
                role="button"
                tabIndex={0}
                aria-label={`Inspect action ${e.title}, expected ${e.expected_score?.toFixed(2) ?? 'unknown'}, observed ${score(e.id)}`}
                onClick={() => onSelect(e.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelect(e.id)
                  }
                }}
                className="cursor-pointer"
              >
                <path
                  d={path}
                  fill="none"
                  className={selected === e.id ? 'stroke-primary' : 'stroke-muted-foreground'}
                  strokeWidth={selected === e.id ? 3 : 1.5}
                  markerEnd="url(#graph-arrow)"
                />
                <path d={path} fill="none" stroke="transparent" strokeWidth={18} />
                <text
                  x={(a.x + b.x + 170) / 2}
                  y={(a.y + b.y) / 2 + 15}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {e.expected_score?.toFixed(2) ?? 'unknown'} → {score(e.id)}
                </text>
              </g>
            )
          })}
          {graph.nodes.map((n) => {
            const p = positions.get(n.id)!
            const matched = matchedIds
              ? matchedIds.includes(n.id)
              : !search ||
                `${n.title} ${n.description} ${n.body}`.toLowerCase().includes(search.toLowerCase())
            return (
              <g
                key={n.id}
                transform={`translate(${p.x},${p.y})`}
                data-entity={n.id}
                role="button"
                tabIndex={0}
                aria-label={`${n.title}: ${n.kind}, ${n.state}`}
                onClick={() => onSelect(n.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(n.id)
                  }
                }}
                className="cursor-pointer"
                opacity={matched ? 1 : 0.25}
              >
                <rect
                  width={170}
                  height={62}
                  rx={6}
                  className={`${selected === n.id ? 'stroke-primary' : 'stroke-border'} ${n.kind === 'goal' ? 'fill-secondary' : 'fill-background'}`}
                  strokeWidth={selected === n.id ? 2 : 1}
                  strokeDasharray={n.state === 'deactivated' ? '4 3' : undefined}
                />
                <text x={12} y={24} className="fill-foreground text-[12px]">
                  {n.title.length > 23 ? n.title.slice(0, 22) + '…' : n.title}
                </text>
                <text x={12} y={44} className="fill-muted-foreground text-[10px]">
                  {n.kind} · {n.kind === 'goal' ? graph.goal_verification : n.state}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}

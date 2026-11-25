import { graphPhase, PHASE_CLASS } from '@/lib/graphPhase'

/** Same node, different kind of update: show whether a step plans the work or executes it. */
export function GraphPhaseBadge({ role }: { role: string }) {
  const phase = graphPhase(role)
  return (
    <span
      data-graph-phase={phase}
      className={`mr-1.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${PHASE_CLASS[phase]}`}
    >
      {phase}
    </span>
  )
}

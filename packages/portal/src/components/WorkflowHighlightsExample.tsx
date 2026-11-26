import { Button } from './ui/button'

const roles = [
  { label: 'PLAN', text: 'text-status-info', note: 'Planning phase' },
  { label: 'EXECUTION', text: 'text-status-success', note: 'Execution or verified evidence' },
  { label: 'GRADING', text: 'text-status-violet', note: 'Grading badge or proposed state' },
  { label: 'RECOVERY', text: 'text-status-warning', note: 'Needs attention' },
  { label: 'ERROR', text: 'text-status-danger', note: 'Failure or destructive consequence' }
]

const weights = [4, 10, 16, 24]

/** Live swatches of the workflow palette, built from the same tokens the graph and inbox use. */
export function WorkflowHighlightsExample() {
  return (
    <section aria-label="Workflow highlight samples" className="my-5 space-y-4 rounded-lg border bg-card p-4 sm:p-6">
      <ul className="grid gap-2 sm:grid-cols-2">
        {roles.map((r) => (
          <li key={r.label} className="flex items-center gap-3 rounded-md border px-3 py-2">
            <span className={`rounded bg-status-tint px-2 py-1 text-xs font-semibold tracking-wide ${r.text}`}>
              {r.label}
            </span>
            <span className="text-sm text-muted-foreground">{r.note}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border-l-4 border-l-status-warning bg-status-warning/10 px-3 py-2">
        <p className="text-sm">
          <b className="text-status-warning">PLAN</b> · Merge result is waiting for your review
        </p>
        <Button size="sm" variant="outline">Review result</Button>
      </div>
      <div>
        <p className="mb-2 text-xs text-muted-foreground">Candidate heatmap: attention mixed in from 4% to 24%</p>
        <div className="grid grid-cols-4 gap-2">
          {weights.map((w, i) => (
            <div
              key={w}
              className="rounded-md border px-2 py-2 text-center text-sm tabular-nums"
              style={{ background: `color-mix(in srgb, var(--color-status-warning) ${w}%, var(--color-card))` }}
            >
              <b>{(w / 24).toFixed(2)}</b>
              <span className="ml-1 text-xs text-muted-foreground">#{i + 1}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

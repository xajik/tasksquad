import { CheckCircle2, Loader2, Circle } from 'lucide-react'

interface CloseStepsProgressProps {
  steps: string[]
  activeIdx: number // index of the currently executing step (-1 = not started)
}

export function CloseStepsProgress({ steps, activeIdx }: CloseStepsProgressProps) {
  if (!steps.length) return null

  return (
    <div style={{ padding: '12px 0 4px' }}>
      <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-muted-foreground)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 8 }}>
        Closing session
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {steps.map((step, i) => {
          const done = i < activeIdx
          const active = i === activeIdx
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {done ? (
                <CheckCircle2 style={{ width: 15, height: 15, color: 'var(--color-status-success)', flexShrink: 0 }} />
              ) : active ? (
                <Loader2 style={{ width: 15, height: 15, color: 'var(--color-status-info)', flexShrink: 0, animation: 'spin 1s linear infinite' }} />
              ) : (
                <Circle style={{ width: 15, height: 15, color: 'var(--color-border)', flexShrink: 0 }} />
              )}
              <code className={done ? 'bg-status-success/10 text-status-success' : active ? 'bg-status-info/10 text-status-info' : 'text-muted-foreground'} style={{
                fontSize: 12,
                fontFamily: 'JetBrains Mono, monospace',
                padding: done || active ? '1px 6px' : undefined,
                borderRadius: 4,
              }}>
                {step}
              </code>
            </div>
          )
        })}
      </div>
    </div>
  )
}

import { CheckCircle2, Loader2, Circle } from 'lucide-react'

interface CloseStepsProgressProps {
  steps: string[]
  activeIdx: number // index of the currently executing step (-1 = not started)
}

export function CloseStepsProgress({ steps, activeIdx }: CloseStepsProgressProps) {
  if (!steps.length) return null

  return (
    <div style={{ padding: '12px 0 4px' }}>
      <p style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 8 }}>
        Closing session
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {steps.map((step, i) => {
          const done = i < activeIdx
          const active = i === activeIdx
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {done ? (
                <CheckCircle2 style={{ width: 15, height: 15, color: '#16a34a', flexShrink: 0 }} />
              ) : active ? (
                <Loader2 style={{ width: 15, height: 15, color: '#2563eb', flexShrink: 0, animation: 'spin 1s linear infinite' }} />
              ) : (
                <Circle style={{ width: 15, height: 15, color: '#d1d5db', flexShrink: 0 }} />
              )}
              <code style={{
                fontSize: 12,
                fontFamily: 'JetBrains Mono, monospace',
                color: done ? '#16a34a' : active ? '#2563eb' : '#9ca3af',
                background: done ? '#f0fdf4' : active ? '#eff6ff' : 'transparent',
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

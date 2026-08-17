import { useState } from 'react'
import { Terminal, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LiveTerminal } from './LiveTerminal'

// Collapsed by default — even the moment tuiBlocked flips true, this does
// NOT auto-expand. LiveTerminal (and its WebSocket) only mounts once
// expanded; the relay's replay=1 backfill means nothing is lost by
// connecting late.
export function LiveTerminalSection({ sessionId, tuiBlocked }: { sessionId: string; tuiBlocked: boolean }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className={cn(
        'mb-4 rounded-xl border overflow-hidden',
        tuiBlocked
          ? 'border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-950/10'
          : 'border-border/60 bg-background'
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(x => !x)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
      >
        <Terminal className={cn('h-3.5 w-3.5 shrink-0', tuiBlocked ? 'text-amber-500' : 'text-muted-foreground')} />
        <span
          className={cn(
            'text-xs font-semibold uppercase tracking-wider shrink-0',
            tuiBlocked ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
          )}
        >
          Live terminal
        </span>
        <span
          className={cn(
            'text-xs flex-1',
            tuiBlocked ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-muted-foreground'
          )}
        >
          {tuiBlocked
            ? 'Agent is waiting on a terminal prompt — click to respond directly'
            : "You can talk to the agent's raw terminal here"}
        </span>
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 opacity-50 transition-transform',
            expanded && 'rotate-90'
          )}
        />
      </button>
      {expanded && (
        <div style={{ height: 'calc(100vh - 380px)', minHeight: 300 }} className="border-t border-border/40">
          <LiveTerminal sessionId={sessionId} />
        </div>
      )}
    </div>
  )
}

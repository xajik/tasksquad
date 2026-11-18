import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { graphHelp, type GraphHelpKey } from '@/lib/graphHelp'

const WIDTH = 320
const MARGIN = 12

/** A small (i) button that shows an explanation and two examples on hover or keyboard focus. The popup is portalled to the page body so a transformed dialog never offsets or clips it. */
export function FieldHelp({ field }: { field: GraphHelpKey }) {
  const help = graphHelp[field]
  const button = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null)
  const id = useId()
  const open = useCallback(() => {
    const rect = button.current?.getBoundingClientRect()
    if (!rect) return
    const left = Math.min(Math.max(MARGIN, rect.left + rect.width / 2 - WIDTH / 2), window.innerWidth - WIDTH - MARGIN)
    const above = rect.bottom + 220 > window.innerHeight && rect.top > 240
    setPos({ left, top: above ? rect.top - 8 : rect.bottom + 8, above })
  }, [])
  const close = useCallback(() => setPos(null), [])
  return (
    <span className="inline-flex" onMouseEnter={open} onMouseLeave={close}>
      <button
        ref={button}
        type="button"
        aria-label="What is this setting?"
        aria-describedby={pos ? id : undefined}
        onFocus={open}
        onBlur={close}
        onClick={(e) => e.preventDefault()}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] font-semibold leading-none text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2"
      >
        i
      </button>
      {pos &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            style={{ left: pos.left, top: pos.top, width: WIDTH, transform: pos.above ? 'translateY(-100%)' : undefined }}
            className="pointer-events-none fixed z-[100] space-y-2 rounded-md border bg-popover p-3 text-xs font-normal leading-snug text-popover-foreground shadow-lg"
          >
            <span className="block">{help.what}</span>
            {help.examples.map((example, i) => (
              <span key={i} className="block rounded bg-muted px-2 py-1 whitespace-pre-line">
                <span className="font-semibold">Example {i + 1}: </span>
                {example}
              </span>
            ))}
          </span>,
          document.body
        )}
    </span>
  )
}

/** Label text followed by its (i) help button. */
export function LabelText({ field, children }: { field: GraphHelpKey; children: ReactNode }) {
  return (
    <span className="inline-flex items-center">
      {children}
      <FieldHelp field={field} />
    </span>
  )
}

import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { FieldHelp } from '@/components/FieldHelp'
import type { GraphHelpKey } from '@/lib/graphHelp'

const key = (id: string) => `graph-section:${id}`
function initial(id: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key(id))
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

/** A titled, collapsible block with an (i) explanation next to the title. The open state is remembered per browser. */
export function GraphSection({
  id,
  title,
  help,
  defaultOpen = true,
  className = '',
  children
}: {
  id: string
  title: ReactNode
  help: GraphHelpKey
  defaultOpen?: boolean
  className?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(() => initial(id, defaultOpen))
  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(key(id), next ? '1' : '0')
    } catch {
      /* remembering the state is optional */
    }
  }
  return (
    <section className={className}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          className="inline-flex items-center gap-1.5 font-semibold text-left hover:text-primary"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {title}
        </button>
        <FieldHelp field={help} />
      </div>
      {open && (
        <div id={`${id}-body`} className="mt-2">
          {children}
        </div>
      )}
    </section>
  )
}

import {
  forwardRef,
  useRef,
  useState,
  useCallback,
  useEffect,
  type TextareaHTMLAttributes,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react'
import Fuse from 'fuse.js'
import { cn } from '@/lib/utils'
import { AutocompleteDropdown } from './AutocompleteDropdown'
import { useAutocompleteData, type AutocompleteItem } from '@/hooks/useAutocompleteData'

export interface AutocompleteTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> {
  value: string
  onChange: (value: string) => void
  teamId: string
}

// Scan backwards from cursor to find a trigger character (@, /)
// Returns null if there's no valid trigger (preceded by whitespace or start of line)
function detectTrigger(text: string, cursorPos: number) {
  for (let i = cursorPos - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === ' ' || ch === '\n' || ch === '\t') return null
    if (ch === '@' || ch === '/') {
      const atStart = i === 0 || text[i - 1] === ' ' || text[i - 1] === '\n' || text[i - 1] === '\t'
      if (atStart) {
        return {
          trigger: ch as '@' | '/',
          triggerStart: i,
          query: text.slice(i + 1, cursorPos),
        }
      }
      return null
    }
  }
  return null
}

function filterItems(items: AutocompleteItem[], trigger: '@' | '/', query: string): AutocompleteItem[] {
  const pool = items.filter(i => i.trigger === trigger)
  if (!query) return pool.slice(0, 10)
  return new Fuse(pool, { keys: ['name', 'description'], threshold: 0.4 })
    .search(query)
    .map(r => r.item)
    .slice(0, 10)
}

export const AutocompleteTextarea = forwardRef<HTMLTextAreaElement, AutocompleteTextareaProps>(
  ({ value, onChange, teamId, className, onKeyDown, ...rest }, forwardedRef) => {
    const internalRef = useRef<HTMLTextAreaElement>(null)
    const { items, load } = useAutocompleteData(teamId)

    const [open, setOpen] = useState(false)
    const [filtered, setFiltered] = useState<AutocompleteItem[]>([])
    const [activeIndex, setActiveIndex] = useState(0)
    const [activeTrigger, setActiveTrigger] = useState<'@' | '/' | null>(null)
    const [triggerStart, setTriggerStart] = useState(0)
    const [currentQuery, setCurrentQuery] = useState('')

    const close = useCallback(() => {
      setOpen(false)
      setActiveIndex(0)
      setActiveTrigger(null)
    }, [])

    const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value
      const cursor = e.target.selectionStart ?? newValue.length
      onChange(newValue)

      const detected = detectTrigger(newValue, cursor)
      if (detected) {
        load()
        setActiveTrigger(detected.trigger)
        setTriggerStart(detected.triggerStart)
        setCurrentQuery(detected.query)
        const result = filterItems(items, detected.trigger, detected.query)
        setFiltered(result)
        setActiveIndex(0)
        setOpen(result.length > 0 || items.length === 0) // keep open even if items not loaded yet
      } else {
        close()
      }
    }, [onChange, items, load, close])

    // Re-filter when items finish loading
    useEffect(() => {
      if (!open || !activeTrigger) return
      const result = filterItems(items, activeTrigger, currentQuery)
      setFiltered(result)
      if (result.length === 0) setOpen(false)
    }, [items, open, activeTrigger, currentQuery])

    const selectItem = useCallback((item: AutocompleteItem) => {
      const textarea = internalRef.current
      if (!textarea) return
      const cursor = textarea.selectionStart ?? value.length
      const insertion = `${item.trigger}${item.name} `
      const newValue = value.slice(0, triggerStart) + insertion + value.slice(cursor)
      onChange(newValue)
      requestAnimationFrame(() => {
        textarea.focus()
        const newCursor = triggerStart + insertion.length
        textarea.setSelectionRange(newCursor, newCursor)
      })
      close()
    }, [value, onChange, triggerStart, close])

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (open) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setActiveIndex(i => Math.min(i + 1, filtered.length - 1))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setActiveIndex(i => Math.max(i - 1, 0))
          return
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && filtered[activeIndex]) {
          e.preventDefault()
          selectItem(filtered[activeIndex])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          close()
          return
        }
      }
      onKeyDown?.(e)
    }, [open, filtered, activeIndex, selectItem, close, onKeyDown])

    // Merge forwarded ref with internal ref
    const setRef = useCallback((el: HTMLTextAreaElement | null) => {
      (internalRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el
      if (typeof forwardedRef === 'function') forwardedRef(el)
      else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el
    }, [forwardedRef])

    return (
      <div className="relative">
        <textarea
          ref={setRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={close}
          className={cn(
            'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          {...rest}
        />
        {open && (
          <AutocompleteDropdown
            items={filtered}
            activeIndex={activeIndex}
            onSelect={selectItem}
            style={{ top: '100%', left: 0, marginTop: 4, right: 0, width: 'auto' }}
          />
        )}
      </div>
    )
  }
)

AutocompleteTextarea.displayName = 'AutocompleteTextarea'

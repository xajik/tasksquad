import { useRef, useEffect, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import type { AutocompleteItem } from '@/hooks/useAutocompleteData'

interface Props {
  items: AutocompleteItem[]
  activeIndex: number
  onSelect: (item: AutocompleteItem) => void
  style?: CSSProperties
  className?: string
}

// Each item is ~52px tall (py-2 + name + description). 3 × 52 = 156px.
const VISIBLE_ITEMS = 3
const ITEM_HEIGHT_PX = 52

export function AutocompleteDropdown({ items, activeIndex, onSelect, style, className }: Props) {
  if (items.length === 0) return null

  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  // For labeled sections, store the label element so we can scroll to it
  // when the first item in that section becomes active.
  const labelRefs = useRef<Record<string, HTMLDivElement | null>>({})
  // Maps each item index → which element to scroll to when that index is active.
  const scrollAnchors = useRef<(HTMLButtonElement | HTMLDivElement | null)[]>([])

  const commands = items.filter(i => i.type === 'command')
  const skills = items.filter(i => i.type === 'skill')
  const subagents = items.filter(i => i.type === 'subagent')
  const hasMixedSlash = commands.length > 0 && skills.length > 0

  // Recompute scroll anchors whenever items change.
  // For the first item in each labeled section, the anchor is the section label.
  // For all other items the anchor is the item button itself.
  const firstCommandIdx = hasMixedSlash ? items.indexOf(commands[0]) : -1
  const firstSkillIdx = hasMixedSlash ? items.indexOf(skills[0]) : -1

  useEffect(() => {
    let anchor: HTMLButtonElement | HTMLDivElement | null = itemRefs.current[activeIndex]
    if (activeIndex === firstCommandIdx && labelRefs.current['commands']) {
      anchor = labelRefs.current['commands']
    } else if (activeIndex === firstSkillIdx && labelRefs.current['skills']) {
      anchor = labelRefs.current['skills']
    }
    anchor?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, firstCommandIdx, firstSkillIdx])

  const renderItem = (item: AutocompleteItem) => {
    const idx = items.indexOf(item)
    return (
      <button
        key={item.id}
        ref={el => { itemRefs.current[idx] = el; scrollAnchors.current[idx] = el }}
        type="button"
        onMouseDown={e => { e.preventDefault(); onSelect(item) }}
        className={cn(
          'flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors hover:bg-muted',
          idx === activeIndex && 'bg-muted',
        )}
      >
        <span className="text-sm font-medium">
          {item.trigger}{item.name}
        </span>
        {item.description && (
          <span className="line-clamp-1 text-xs text-muted-foreground">
            {item.description}
          </span>
        )}
      </button>
    )
  }

  const sectionLabel = (text: string, refKey: string) => (
    <div
      key={text}
      ref={el => { labelRefs.current[refKey] = el }}
      className="border-b px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
    >
      {text}
    </div>
  )

  return (
    <div
      className={cn('absolute z-50 w-72 rounded-md border bg-popover text-popover-foreground shadow-md', className)}
      style={style}
    >
      <div
        className="overflow-y-auto"
        style={{ maxHeight: VISIBLE_ITEMS * ITEM_HEIGHT_PX }}
      >
        {subagents.map(renderItem)}
        {hasMixedSlash ? (
          <>
            {sectionLabel('Commands', 'commands')}
            {commands.map(renderItem)}
            {sectionLabel('Skills', 'skills')}
            {skills.map(renderItem)}
          </>
        ) : (
          <>
            {commands.map(renderItem)}
            {skills.map(renderItem)}
          </>
        )}
      </div>
      {items.length > VISIBLE_ITEMS && (
        <div className="border-t px-3 py-1 text-[10px] text-muted-foreground">
          ↑↓ to scroll · {items.length} results
        </div>
      )}
    </div>
  )
}

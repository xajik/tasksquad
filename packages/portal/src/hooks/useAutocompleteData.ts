import { useState, useCallback, useRef } from 'react'
import { api, type SubAgent, type Skill, type Command } from '../lib/api'

export interface AutocompleteItem {
  id: string
  name: string
  description?: string
  type: 'subagent' | 'skill' | 'command'
  trigger: '@' | '/'
}

export function useAutocompleteData(teamId: string) {
  const [items, setItems] = useState<AutocompleteItem[]>([])
  const loadedRef = useRef(false)
  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (loadedRef.current || loadingRef.current) return
    loadingRef.current = true
    try {
      const [sa, sk, cm] = await Promise.all([
        api.subAgents.list(teamId),
        api.skills.list(teamId),
        api.commands.list(teamId),
      ])
      const result: AutocompleteItem[] = [
        ...(sa.sub_agents ?? []).map((s: SubAgent) => ({
          id: s.id, name: s.name, description: s.description,
          type: 'subagent' as const, trigger: '@' as const,
        })),
        ...(cm.commands ?? []).map((c: Command) => ({
          id: c.id, name: c.name, description: c.description,
          type: 'command' as const, trigger: '/' as const,
        })),
        ...(sk.skills ?? []).map((s: Skill) => ({
          id: s.id, name: s.name, description: s.description,
          type: 'skill' as const, trigger: '/' as const,
        })),
      ]
      setItems(result)
      loadedRef.current = true
    } finally {
      loadingRef.current = false
    }
  }, [teamId])

  return { items, load }
}

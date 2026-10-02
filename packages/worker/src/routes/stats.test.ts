import { describe, it, expect } from 'vitest'
import { aggregateStats, sanitizeCounts, sanitizeMetrics, type MetricsRow, type TaskRow } from './stats.js'

const DAY = 86_400_000
const from = Date.UTC(2026, 8, 1)
const to = from + 3 * DAY - 1

const task = (over: Partial<TaskRow>): TaskRow => ({
  id: 't', agent_id: 'a1', status: 'done', created_at: from + 1000, completed_at: null, grade: null, started: 1, ...over,
})
const metric = (over: Partial<MetricsRow>): MetricsRow => ({
  agent_id: 'a1', provider: 'claude-code', model: 'm', duration_ms: 0, turns: 0, input_tokens: 0, output_tokens: 0,
  cache_read_tokens: 0, cache_write_tokens: 0, tool_calls: 0, tool_errors: 0, tools: '{}', skills: '{}', ...over,
})

describe('sanitizeMetrics', () => {
  it('clamps numbers and drops junk', () => {
    const m = sanitizeMetrics({ provider: 'codex', duration_ms: -5, turns: 3.9, tokens: { input: 1e20, output: 'x' },
      tools: { Bash: 4, '': 2, Edit: 0, Read: -1, [`${'x'.repeat(200)}`]: 1 }, skills: 'nope' })
    expect(m.duration_ms).toBe(0)
    expect(m.turns).toBe(3)
    expect(m.input_tokens).toBe(1_000_000_000)
    expect(m.output_tokens).toBe(0)
    expect(m.tools.Bash).toBe(4)
    expect(Object.keys(m.tools)).toHaveLength(2) // Bash + truncated long name
    expect(Object.keys(m.tools).every(k => k.length <= 120)).toBe(true)
    expect(m.skills).toEqual({})
    expect(m.tool_calls).toBe(5) // derived from tools when no total is reported
  })

  it('keeps only the most used names', () => {
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`tool${i}`, i + 1]))
    const kept = sanitizeCounts(many)
    expect(Object.keys(kept)).toHaveLength(100)
    expect(kept.tool149).toBe(150)
    expect(kept.tool0).toBeUndefined()
  })

  it('trusts a reported tool_calls total', () => {
    expect(sanitizeMetrics({ tool_calls: 42, tools: { Bash: 1 } }).tool_calls).toBe(42)
  })
})

describe('aggregateStats', () => {
  const agents = [{ id: 'a1', name: 'claude' }, { id: 'a2', name: 'codex' }]

  it('counts statuses, success rate, grades and median completion', () => {
    const s = aggregateStats({ from, to, tzOffsetMinutes: 0, agents, metrics: [], tasks: [
      task({ id: '1', status: 'done', completed_at: from + 1000 + 60_000, grade: 1 }),
      task({ id: '2', status: 'done', completed_at: from + 1000 + 180_000 }),
      task({ id: '3', status: 'failed', grade: 0 }),
      task({ id: '4', status: 'running', agent_id: 'a2' }),
      task({ id: '5', status: 'pending', agent_id: 'a2', started: 0 }),
      task({ id: '6', status: 'cancelled' }),
    ] })
    expect(s.totals).toMatchObject({ created: 6, started: 5, done: 2, failed: 1, cancelled: 1, in_progress: 2, grades_up: 1, grades_down: 1 })
    expect(s.totals.success_rate).toBeCloseTo(2 / 3)
    expect(s.totals.median_completion_ms).toBe(120_000)
    const claude = s.agents.find(a => a.agent_id === 'a1')!
    expect(claude).toMatchObject({ name: 'claude', tasks: 4, done: 2, failed: 1, median_completion_ms: 120_000 })
    expect(s.agents.find(a => a.agent_id === 'a2')!.success_rate).toBeNull()
  })

  it('buckets days in the viewer time zone and fills empty days', () => {
    // 23:30 UTC on day 0 is day 1 for a viewer at UTC+1 (offset -60).
    const late = from + DAY - 30 * 60_000
    const utc = aggregateStats({ from, to, tzOffsetMinutes: 0, agents, metrics: [], tasks: [task({ created_at: late })] })
    const plusOne = aggregateStats({ from, to, tzOffsetMinutes: -60, agents, metrics: [], tasks: [task({ created_at: late })] })
    expect(utc.daily.find(d => d.created)!.date).toBe('2026-09-01')
    expect(plusOne.daily.find(d => d.created)!.date).toBe('2026-09-02')
    expect(utc.daily.length).toBeGreaterThanOrEqual(3)
    expect(utc.daily.reduce((n, d) => n + d.created, 0)).toBe(1)
  })

  it('sums usage and ranks tools, skills and models', () => {
    const s = aggregateStats({ from, to, tzOffsetMinutes: 0, agents, tasks: [], metrics: [
      metric({ duration_ms: 1000, turns: 2, input_tokens: 10, output_tokens: 5, tool_calls: 3, tool_errors: 1,
               tools: '{"Bash":2,"Edit":1}', skills: '{"tsq-end-session-learning":1}', model: 'opus' }),
      metric({ agent_id: 'a2', duration_ms: 500, tool_calls: 4, tools: '{"Bash":4}', skills: 'not json', model: 'gpt' }),
      metric({ agent_id: 'gone', model: 'opus' }),
    ] })
    expect(s.usage).toMatchObject({ sessions_reported: 3, active_ms: 1500, turns: 2, input_tokens: 10, output_tokens: 5, tool_calls: 7, tool_errors: 1 })
    expect(s.tools).toEqual([{ name: 'Bash', count: 6 }, { name: 'Edit', count: 1 }])
    expect(s.skills).toEqual([{ name: 'tsq-end-session-learning', count: 1 }])
    expect(s.usage.models[0]).toEqual({ name: 'opus', sessions: 2 })
    expect(s.agents.find(a => a.agent_id === 'gone')!.name).toBe('Deleted agent')
  })
})

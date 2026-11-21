import { describe, it, expect } from 'vitest'
import { executionStats, graphView, predicateState, staleJobs } from './graphDashboard'
import type { GraphSnapshot } from './graph'

const fixture = () =>
  ({
    created_at: 0,
    config: { rule: { scope: 'Production' } },
    evidence: [],
    results: [],
    assignments: [{ id: 'queued', role: 'execute', status: 'pending', created_at: 0 }],
    attempts: []
  }) as unknown as GraphSnapshot

describe('graph dashboard diagnostics', () => {
  it('keeps conflicting, expired, and wrong-scope evidence from verifying a predicate', () => {
    const g = fixture()
    g.evidence = [
      { predicate: 'paid', value: 'true', scope: 'Production', expires_at: 2000 },
      { predicate: 'paid', value: 'false', scope: 'Production', expires_at: 2000 }
    ] as GraphSnapshot['evidence']
    expect(predicateState(g, 'paid', 1000)).toBe('Unverified')
    g.evidence.pop()
    expect(predicateState(g, 'paid', 1000)).toBe('Verified')
    expect(predicateState(g, 'paid', 2000)).toBe('Unverified')
    g.config.rule.scope = 'Staging'
    expect(predicateState(g, 'paid', 1000)).toBe('Unverified')
  })
  it('distinguishes aged waiting work from overdue running attempts and resolved history', () => {
    const g = fixture()
    expect(staleJobs(g, 999, 1000)).toEqual([])
    expect(staleJobs(g, 1001, 1000)[0].diagnosis).toBe('Long waiting')
    g.assignments[0].status = 'running'
    g.attempts = [
      { id: 't', assignment_id: 'queued', status: 'running', created_at: 0, deadline: 500, epoch: 1 }
    ] as GraphSnapshot['attempts']
    expect(staleJobs(g, 1001, 1000)[0].diagnosis).toBe('Past deadline')
    g.assignments[0].status = 'accepted'
    g.attempts[0].status = 'timeout'
    expect(staleJobs(g, 1001, 1000)).toEqual([])
  })
  it('uses completion time for throughput and separates accepted results from executions', () => {
    const g = fixture()
    g.attempts = [
      { id: 'a', assignment_id: 'queued', status: 'completed', created_at: 0, completed_at: 1100 },
      { id: 'b', assignment_id: 'queued', status: 'timeout', created_at: 1000, completed_at: 1400 },
      { id: 'c', assignment_id: 'queued', status: 'running', created_at: 1200, completed_at: null }
    ] as GraphSnapshot['attempts']
    const stats = executionStats(g, 1000, 2000)
    expect(stats.finished).toHaveLength(2)
    expect(stats.timeouts).toBe(1)
    expect(stats.buckets.reduce((sum, b) => sum + b.completed + b.timeout, 0)).toBe(2)
    expect(stats.p95).toBe(1100)
    expect(stats.median).toBe(750)
    expect(stats.accepted).toBe(0)
    expect(graphView('candidates')).toBe('candidates')
    expect(graphView('invalid')).toBe('home')
  })
})

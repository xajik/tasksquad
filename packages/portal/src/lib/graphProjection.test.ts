import { describe, it, expect } from 'vitest'
import type { GraphSnapshot } from './graph'
import { goalProjection } from './graphProjection'
function fixture() {
  return {
    nodes: [
      { id: 'start', kind: 'observed' },
      { id: 'candidate', kind: 'outcome', source_result_id: 'merge' },
      { id: 'observed', kind: 'outcome', source_result_id: 'execution' },
      { id: 'other', kind: 'outcome', source_result_id: 'other-execution' }
    ],
    edges: [{ id: 'edge', from_id: 'start', to_id: 'candidate' }],
    assignments: [
      { id: 'execute', role: 'execute', node_id: 'candidate', edge_id: 'edge', input: '{}' },
      { id: 'other-execute', role: 'execute', node_id: 'other', input: '{}' },
      { id: 'grade', role: 'grade', input: JSON.stringify({ execution_result_id: 'execution' }) },
      { id: 'project', role: 'project', input: JSON.stringify({ execution_result_id: 'execution' }) }
    ],
    attempts: [
      { id: 'execute-attempt', assignment_id: 'execute' },
      { id: 'other-attempt', assignment_id: 'other-execute' },
      { id: 'grade-attempt', assignment_id: 'grade' },
      { id: 'project-attempt', assignment_id: 'project' }
    ],
    results: [
      { id: 'execution', attempt_id: 'execute-attempt', status: 'accepted', accepted_at: 1, created_at: 1 },
      {
        id: 'other-execution',
        attempt_id: 'other-attempt',
        status: 'accepted',
        accepted_at: 2,
        created_at: 2
      },
      {
        id: 'grade',
        attempt_id: 'grade-attempt',
        status: 'accepted',
        accepted_at: 3,
        created_at: 3,
        parsed: JSON.stringify({ local_score: 1 })
      },
      {
        id: 'projection',
        attempt_id: 'project-attempt',
        status: 'accepted',
        accepted_at: 4,
        created_at: 4,
        parsed: JSON.stringify({ goal_score: 0.7, reason: 'Supports the goal', evidence_ids: ['proof'] })
      }
    ]
  } as unknown as GraphSnapshot
}
describe('selected state goal projection', () => {
  it('uses the accepted private projection for observed and candidate states', () => {
    const graph = fixture()
    for (const id of ['observed', 'candidate'])
      expect(goalProjection(graph, id)).toMatchObject({
        score: 0.7,
        evaluated: true,
        executionResultId: 'execution',
        resultId: 'projection',
        evidenceIds: ['proof']
      })
    expect(goalProjection(graph, 'other').evaluated).toBe(false)
    expect(goalProjection(graph, 'start').evaluated).toBe(false)
  })
  it('never substitutes local quality or pending/rejected projection output', () => {
    const graph = fixture()
    graph.results.find((r) => r.id === 'projection')!.status = 'review'
    expect(goalProjection(graph, 'observed')).toMatchObject({ score: null, evaluated: false })
    graph.results.find((r) => r.id === 'projection')!.status = 'rejected'
    expect(goalProjection(graph, 'observed').evaluated).toBe(false)
  })
  it('a newer unknown regrade replaces the earlier positive score', () => {
    const graph = fixture()
    const old = graph.results.find((r) => r.id === 'projection')!
    graph.results.push({
      ...old,
      id: 'regrade',
      created_at: 10,
      accepted_at: 10,
      parsed: JSON.stringify({ goal_score: null, reason: 'Evidence uncertain', evidence_ids: [] })
    })
    expect(goalProjection(graph, 'observed')).toMatchObject({
      score: null,
      evaluated: true,
      resultId: 'regrade',
      reason: 'Evidence uncertain'
    })
  })
})

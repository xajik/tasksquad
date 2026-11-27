import { expect, it } from 'vitest'
import { rankedPlans, executionGrade } from './graphPredictions'
import type { GraphSnapshot } from './graph'

it('ranks plans from observations by prediction, keeps zero ahead of unknown and breaks ties by ID', () => {
  const graph = {
    nodes: [
      { id: 'start', kind: 'observed', state: 'active' },
      { id: 'actual', source_result_id: 'run', state: 'active' },
      { id: 'retired', kind: 'observed', state: 'deactivated' },
      { id: 'proposed', source_result_id: 'proposal', state: 'active' }
    ],
    edges: [
      { id: 'a', from_id: 'start', expected_score: null },
      { id: 'b', from_id: 'actual', expected_score: 0 },
      { id: 'd', from_id: 'actual', expected_score: 0.8 },
      { id: 'c', from_id: 'retired', expected_score: 0.8 },
      { id: 'x', from_id: 'proposed', expected_score: 1 }
    ],
    assignments: [
      { id: 'old', role: 'execute', edge_id: 'd', status: 'accepted', created_at: 1 },
      { id: 'next', role: 'execute', edge_id: 'd', status: 'pending', created_at: 2 },
      { id: 'review', role: 'grade', edge_id: 'b', status: 'pending' },
      { id: 'inactive', role: 'execute', edge_id: 'c', status: 'pending' }
    ]
  } as unknown as GraphSnapshot
  const plans = rankedPlans(graph, new Set(['run']))
  expect(plans.map((p) => p.edge.id)).toEqual(['c', 'd', 'b', 'a'])
  expect(plans.filter((p) => p.pending).map((p) => p.work?.id)).toEqual(['next'])
})

it('shows the latest accepted local grade for the selected execution, including repaired grades', () => {
  const graph = {
    assignments: [
      { id: 'execute', role: 'execute' },
      { id: 'grade', role: 'grade', input: '{"execution_result_id":"run"}' },
      { id: 'repair', role: 'repair', parent_id: 'grade' },
      { id: 'other', role: 'grade', input: '{"execution_result_id":"elsewhere"}' }
    ],
    attempts: ['execute', 'grade', 'repair', 'other'].map((id) => ({ id, assignment_id: id, agent_id: id })),
    results: [
      { id: 'run', attempt_id: 'execute', status: 'accepted' },
      { attempt_id: 'grade', status: 'accepted', accepted_at: 1, parsed: '{"local_score":1}' },
      {
        attempt_id: 'repair',
        status: 'accepted',
        accepted_at: 2,
        parsed: '{"local_score":0,"reason":"No evidence"}'
      },
      { attempt_id: 'grade', status: 'review', created_at: 3, parsed: '{"local_score":1}' },
      { attempt_id: 'other', status: 'accepted', accepted_at: 4, parsed: '{"local_score":1}' }
    ]
  } as unknown as GraphSnapshot
  expect(executionGrade(graph, graph.assignments[0])).toEqual({
    agentId: 'repair',
    local_score: 0,
    reason: 'No evidence'
  })
})

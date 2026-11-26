import { expect, it } from 'vitest'
import type { GraphNode, GraphSnapshot } from './graph'
import { nodeHistory } from './graphNodeHistory'

it('keeps repeated transitions in recorded order and includes reviews of this observation', () => {
  const node = {
    id: 'observed', source_result_id: 'exec', created_at: 10,
    state_history: [
      { id: 1, state: 'active', created_at: 10, reason: null },
      { id: 3, state: 'deactivated', created_at: 30, reason: 'expired' },
      { id: 4, state: 'active', created_at: 30, reason: 'restored' }
    ]
  } as GraphNode
  const graph = {
    nodes: [node],
    assignments: [
      { id: 'project', node_id: 'plan-target', role: 'project', created_at: 20, input: '{"execution_result_id":"exec"}' },
      { id: 'unrelated', node_id: 'other', role: 'project', created_at: 22, input: '{"execution_result_id":"other"}' }
    ],
    attempts: [{ id: 'attempt', assignment_id: 'source', task_id: 'task' }],
    results: [{ id: 'exec', attempt_id: 'attempt' }]
  } as unknown as GraphSnapshot
  expect(nodeHistory(graph, node)).toEqual([
    expect.objectContaining({ title: 'Created · active', taskId: 'task', at: 10 }),
    expect.objectContaining({ title: 'Queued · project', at: 20 }),
    expect.objectContaining({ title: 'active → deactivated', detail: 'expired', at: 30 }),
    expect.objectContaining({ title: 'deactivated → active', detail: 'restored', at: 30 })
  ])
})

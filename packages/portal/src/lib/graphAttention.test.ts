import { describe, it, expect } from 'vitest'
import type { GraphSnapshot } from './graph'
import { graphAttention } from './graphAttention'
const fixture = () =>
  ({
    nodes: [
      { id: 'goal', kind: 'goal' },
      { id: 'target', kind: 'outcome' },
      { id: 'observed', kind: 'outcome', source_result_id: 'blocked-result' }
    ],
    edges: [{ id: 'edge', to_id: 'target' }],
    assignments: [{ id: 'a', role: 'execute', node_id: 'target', edge_id: 'edge', status: 'blocked' }],
    attempts: [
      {
        id: 'attempt',
        assignment_id: 'a',
        task_id: 'inbox-task',
        created_at: 1,
        epoch: 1,
        status: 'completed'
      }
    ],
    results: [{ id: 'blocked-result', attempt_id: 'attempt' }]
  }) as unknown as GraphSnapshot
describe('graph inbox attention', () => {
  it('highlights both the blocked action target and observed outcome and links to its inbox task', () => {
    const attention = graphAttention(fixture())
    for (const node of ['target', 'observed'])
      expect(attention.nodes.get(node)?.[0]).toMatchObject({ kind: 'reply', taskId: 'inbox-task' })
    expect(attention.edges.get('edge')?.[0].kind).toBe('reply')
  })
  it('clears blocked attention after a continuation is requested', () => {
    const g = fixture()
    g.assignments[0].status = 'continuation'
    expect(graphAttention(g).nodes.size).toBe(0)
  })
  it('handles live waiting-input tasks and reviews without treating old attempts as current', () => {
    const g = fixture()
    g.assignments[0].status = 'running'
    g.attempts[0].status = 'running'
    g.attempts[0].task_status = 'waiting_input'
    expect(graphAttention(g).nodes.get('target')?.[0].kind).toBe('reply')
    g.attempts.push({ ...g.attempts[0], id: 'new', task_id: 'latest-task', epoch: 2, task_status: 'running' })
    expect(graphAttention(g).nodes.size).toBe(0)
    g.assignments[0].status = 'review'
    expect(graphAttention(g).nodes.get('target')?.[0]).toMatchObject({
      kind: 'review',
      taskId: 'latest-task'
    })
  })
})

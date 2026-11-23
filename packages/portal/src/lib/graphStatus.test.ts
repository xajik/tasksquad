import { describe, expect, it } from 'vitest'
import { graphRunExplanation, latestGraphAttempt, type GraphSnapshot } from './graph'

const fixture = () => ({ status: 'running', assignments: [{ id: 'work', status: 'pending' }], attempts: [], waiting: {
  work: { code: 'cost_budget', message: 'Declared cost 500 exceeds remaining execution limit 100.', action: null, task_id: null, request_title: null }
} }) as unknown as GraphSnapshot

describe('graph status explanations', () => {
  it('explains an exhausted review without pretending the graph is active or requesting an approval', () => {
    const g = fixture()
    g.grading = [{ sequence: 52, stage: 'project', status: 'blocked', assignment_id: 'work', execution_result_id: 'result' }]
    expect(graphRunExplanation(g)).toContain('Blocked: review failed')
    expect(graphRunExplanation(g)).toContain('grading remains incomplete')
  })
  it('explains paused state and the actual reason for idle work', () => {
    const g = fixture()
    expect(graphRunExplanation(g)).toContain('Declared cost 500')
    g.status = 'paused'
    expect(graphRunExplanation(g)).toContain('Paused')
    g.status = 'running'
    g.waiting!.work.action = 'reply'
    expect(graphRunExplanation(g)).toContain('Waiting for your input')
  })
  it('finds the latest attempt by epoch even when the snapshot is unordered', () => {
    const g = fixture()
    g.attempts = [
      { id: 'new', assignment_id: 'work', epoch: 2, task_id: 'new-task', created_at: 2 },
      { id: 'old', assignment_id: 'work', epoch: 1, task_id: 'old-task', created_at: 10 }
    ] as GraphSnapshot['attempts']
    expect(latestGraphAttempt(g, 'work')?.task_id).toBe('new-task')
  })
})

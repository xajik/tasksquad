import { parseJson } from './parseJson'
import type { GraphSnapshot } from './graph'

/** What the person must look at first: their decisions, then recovery, running work, then queued work by priority. */
export const workRank = (status: string) =>
  ['review', 'blocked', 'error'].includes(status)
    ? 0
    : ['reconciling', 'restoring'].includes(status)
      ? 1
      : status === 'running' || status === 'continuation'
        ? 2
        : status === 'pending'
          ? 3
          : 4
export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
/** Where a pending proposal really stands: its independent merge review may be queued, running, held for you or blocked. */
export function proposalState(graph: GraphSnapshot, proposalId: string, status: string): string {
  const merge = graph.assignments.find((a) => {
    if (a.role !== 'merge') return false
    return parseJson<{ proposal_id?: string }>(a.input, {}).proposal_id === proposalId
  })
  switch (merge?.status) {
    case 'pending':
      return 'merge review queued'
    case 'running':
      return 'merge review running'
    case 'review':
      return 'merge review waiting for your decision in the inbox'
    case 'blocked':
    case 'error':
      return 'merge review blocked or rejected — reply in the inbox to continue'
    default:
      return status
  }
}
export const pretty = (value: string) => {
  const parsed = parseJson<unknown>(value, undefined)
  return parsed === undefined ? value : JSON.stringify(parsed, null, 2)
}
export const stamp = (time: number | null) => (time ? new Date(time).toLocaleString() : 'Pending')

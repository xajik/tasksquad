import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { buildApprovalResponse, extractApprovalRequest, parseStructured, validateAnswers } from './approval'

const body = `needs_input:
  title: "Approve interview plan"
  fields:
    - {id: market, type: radio, label: "Market?", required: true, options: [{id: us, label: "US"}, {id: uk, label: "UK"}]}
    - {id: channels, type: checkbox, label: "Channels", options: [{id: x, label: "X"}, {id: reddit, label: "Reddit"}]}
    - {id: notes, type: text, label: "Notes", max_length: 10}
`

describe('approval flow', () => {
  it('detects structured messages only when the whole message is JSON/YAML', () => {
    expect(parseStructured('Finished the task, all good.')).toBeUndefined()
    expect(parseStructured('{"a":1}')).toEqual({ a: 1 })
    expect(parseStructured('```yaml\na: 1\n```')).toEqual({ a: 1 })
    expect(parseStructured('reason: "x"\nbody: y')).toEqual({ reason: 'x', body: 'y' })
  })
  it('extracts requests from YAML, JSON and fenced blocks and rejects bad ones', () => {
    const request = extractApprovalRequest(body)
    expect(request?.fields).toHaveLength(3)
    expect(extractApprovalRequest(JSON.stringify({ needs_input: request }))).not.toBeNull()
    expect(extractApprovalRequest(`Please answer:\n\`\`\`yaml\n${body}\`\`\``)).not.toBeNull()
    expect(extractApprovalRequest('needs_input:\n  title: "x"\n  fields:\n    - {id: a, type: radio, label: "q", options: [{id: o, label: "one"}]}\n')).toBeNull()
    expect(extractApprovalRequest('plain text')).toBeNull()
  })
  it('validates answers and builds a YAML approval_response', () => {
    const request = extractApprovalRequest(body)!
    expect(validateAnswers(request, {})).toMatch(/Market/)
    expect(validateAnswers(request, { market: 'us', notes: 'x'.repeat(11) })).toMatch(/Too long/)
    const text = buildApprovalResponse(request, { market: 'us', channels: ['x', 'reddit'], notes: 'ok: fine' })
    expect(parse(text)).toEqual({
      approval_response: { title: 'Approve interview plan', answers: { market: 'us', channels: ['x', 'reddit'], notes: 'ok: fine' } }
    })
    expect(parse(buildApprovalResponse(request, { market: 'uk', channels: [] })).approval_response.answers).toEqual({ market: 'uk' })
  })
  it('checks the formatted graph reply limit before submission without losing answers', () => {
    const request = { title: 'Details', fields: [
      { id: 'a', type: 'text' as const, label: 'A', max_length: 2000 },
      { id: 'b', type: 'text' as const, label: 'B', max_length: 2000 }
    ] }
    const answers = { a: 'x'.repeat(1990), b: 'y'.repeat(1990) }
    expect(validateAnswers(request, answers)).toBeNull()
    expect(validateAnswers(request, answers, 3999)).toContain('3999-character')
    expect(answers.b).toHaveLength(1990)
    expect(validateAnswers(request, { a: 'short', b: 'short' }, 3999)).toBeNull()
  })
})

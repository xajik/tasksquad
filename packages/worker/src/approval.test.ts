import { describe, expect, it } from 'vitest'
import { extractApprovalRequest } from './approval.js'
import { parseResult } from './graph/contracts.js'

const request = `needs_input:
  title: "Approve interview plan"
  reason: "Missing approvals"
  fields:
    - id: market
      type: radio
      label: "Launch market?"
      required: true
      options:
        - {id: us, label: "United States"}
        - {id: uk, label: "UK"}
    - id: channels
      type: checkbox
      label: "Channels"
      options:
        - {id: x, label: "X"}
    - id: notes
      type: text
      label: "Anything else?"
      max_length: 500
`

describe('approval requests', () => {
  it('extracts from a whole YAML message, a JSON message and a fenced block', () => {
    const yamlRequest = extractApprovalRequest(request)
    expect(yamlRequest?.fields.map((f) => f.type)).toEqual(['radio', 'checkbox', 'text'])
    expect(extractApprovalRequest(JSON.stringify({ needs_input: yamlRequest }))?.title).toBe('Approve interview plan')
    expect(extractApprovalRequest(`Need input:\n\`\`\`yaml\n${request}\`\`\`\nThanks`)?.title).toBe('Approve interview plan')
  })
  it('rejects malformed requests and ordinary text', () => {
    expect(extractApprovalRequest('Just finished the task.')).toBeNull()
    expect(extractApprovalRequest('needs_input:\n  title: "x"\n  fields: []\n')).not.toBeNull()
    expect(extractApprovalRequest('needs_input:\n  title: "x"\n  fields:\n    - {id: a, type: radio, label: "q", options: [{id: o, label: "only"}]}\n')).toBeNull()
    expect(extractApprovalRequest('needs_input:\n  title: "x"\n  fields:\n    - {id: a, type: text, label: "q"}\n    - {id: a, type: text, label: "q2"}\n')).toBeNull()
    expect(extractApprovalRequest(null)).toBeNull()
  })
  it('is accepted by the execute contract only with a blocked outcome', () => {
    const blocked = `outcome: blocked\ntitle: "Needs approval"\ndescription: ""\nbody: "x"\nevidence: []\nactual_cost: 0\n${request}`
    expect(parseResult('execute', blocked).needs_input).toBeTruthy()
    expect(() => parseResult('execute', blocked.replace('outcome: blocked', 'outcome: complete'))).toThrow()
  })
})

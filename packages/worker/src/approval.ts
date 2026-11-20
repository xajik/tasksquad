import { parse as parseYaml } from 'yaml'
import { approvalRequestSchema, checkApprovalRequest, validate } from './graph/contracts.js'

export interface ApprovalField {
  id: string
  type: 'radio' | 'checkbox' | 'text'
  label: string
  required?: boolean
  max_length?: number
  options?: { id: string; label: string }[]
}
export interface ApprovalRequest {
  title: string
  reason?: string
  fields: ApprovalField[]
}

const JSON_START = /^\s*[{\[]/
const YAML_START = /^\s*[A-Za-z_][\w-]*:\s/
const FENCE = /```(?:ya?ml|json)\s*\n([\s\S]*?)\n```/i

/** Validated request, or null when the value is not a well-formed `needs_input`. */
export function normalizeApprovalRequest(value: unknown): ApprovalRequest | null {
  try {
    const request = validate(approvalRequestSchema, value) as ApprovalRequest
    checkApprovalRequest(request)
    return request
  } catch {
    return null
  }
}

function parseBlock(text: string): unknown {
  if (!JSON_START.test(text) && !YAML_START.test(text)) return undefined
  try {
    return parseYaml(text, { schema: 'core', maxAliasCount: 0 })
  } catch {
    return undefined
  }
}

/** Finds a `needs_input` request in an agent message: a message that is wholly JSON/YAML, or a fenced block inside it. */
export function extractApprovalRequest(message: string | null | undefined): ApprovalRequest | null {
  const text = (message ?? '').trim()
  if (!text || text.length > 64 * 1024) return null
  const candidates = [text.replace(/^```(?:ya?ml|json)?\s*\n([\s\S]*?)\n```$/i, '$1')]
  const fenced = FENCE.exec(text)
  if (fenced) candidates.push(fenced[1])
  for (const candidate of candidates) {
    const value = parseBlock(candidate)
    if (value && typeof value === 'object' && !Array.isArray(value) && 'needs_input' in value) {
      const request = normalizeApprovalRequest((value as Record<string, unknown>).needs_input)
      if (request) return request
    }
  }
  return null
}

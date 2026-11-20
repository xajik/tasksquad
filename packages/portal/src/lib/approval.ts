import { parse, stringify } from 'yaml'

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
export type Answers = Record<string, string | string[]>

const JSON_START = /^\s*[{[]/
const YAML_START = /^\s*[A-Za-z_][\w-]*:\s/
const FENCED_WHOLE = /^```(?:ya?ml|json)?\s*\n([\s\S]*?)\n```$/i
const FENCED_ANY = /```(?:ya?ml|json)\s*\n([\s\S]*?)\n```/i

/** The parsed value when a whole message is JSON or YAML (optionally fenced); undefined for ordinary text. */
export function parseStructured(body: string | null | undefined): unknown {
  const text = (body ?? '').trim()
  if (!text || text.length > 64 * 1024) return undefined
  const inner = text.replace(FENCED_WHOLE, '$1')
  if (!JSON_START.test(inner) && !YAML_START.test(inner)) return undefined
  try {
    const value = parse(inner, { schema: 'core', maxAliasCount: 0 })
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

const ID = /^[A-Za-z][A-Za-z0-9_-]*$/
function valid(request: unknown): request is ApprovalRequest {
  const r = request as ApprovalRequest
  if (!r || typeof r.title !== 'string' || !r.title || !Array.isArray(r.fields) || r.fields.length > 8) return false
  const seen = new Set<string>()
  return r.fields.every((f) => {
    if (!f || typeof f.id !== 'string' || !ID.test(f.id) || seen.has(f.id) || typeof f.label !== 'string' || !f.label) return false
    seen.add(f.id)
    const options = Array.isArray(f.options) ? f.options : []
    if (!['radio', 'checkbox', 'text'].includes(f.type)) return false
    if (f.type === 'text') return options.length === 0
    return (
      options.length >= (f.type === 'radio' ? 2 : 1) &&
      options.length <= 12 &&
      options.every((o) => o && typeof o.id === 'string' && !!o.id && typeof o.label === 'string' && !!o.label) &&
      new Set(options.map((o) => o.id)).size === options.length
    )
  })
}

/** A `needs_input` request in an agent message (wholly JSON/YAML, or a fenced block inside the text). */
export function extractApprovalRequest(body: string | null | undefined): ApprovalRequest | null {
  const candidates: unknown[] = [parseStructured(body)]
  const fenced = FENCED_ANY.exec(body ?? '')
  if (fenced) candidates.push(parseStructured(fenced[1]))
  for (const value of candidates) {
    const request = (value as { needs_input?: unknown } | undefined)?.needs_input
    if (request && valid(request)) return request
  }
  return null
}

/** Why the answers cannot be sent yet, or null when complete. */
export function validateAnswers(request: ApprovalRequest, answers: Answers): string | null {
  for (const f of request.fields) {
    const a = answers[f.id]
    const empty = a === undefined || a === '' || (Array.isArray(a) && a.length === 0)
    if (f.required && empty) return `Answer required: ${f.label}`
    if (f.type === 'text' && typeof a === 'string' && a.length > (f.max_length ?? 1000)) return `Too long: ${f.label}`
  }
  return null
}

/** The reply message: a YAML `approval_response` keyed by field id (unanswered optional fields are left out). */
export function buildApprovalResponse(request: ApprovalRequest, answers: Answers): string {
  const given: Answers = {}
  for (const f of request.fields) {
    const a = answers[f.id]
    if (a !== undefined && a !== '' && !(Array.isArray(a) && a.length === 0)) given[f.id] = a
  }
  return stringify(
    { approval_response: { title: request.title, answers: given } },
    { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN', lineWidth: 0 }
  )
}

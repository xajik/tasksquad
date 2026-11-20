import { stringify } from 'yaml'
import { parseStructured } from './approval'

export interface FormattedBody {
  headline: string | null
  rows: { label: string; value: string }[]
}
const HEADLINE = ['reason', 'title', 'summary', 'description', 'message', 'body']
const label = (k: string) => k.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
const scalar = (v: unknown) => (v === null || v === undefined ? '—' : String(v))

function render(v: unknown): string {
  if (Array.isArray(v)) {
    if (!v.length) return 'none'
    return v.every((x) => x === null || typeof x !== 'object')
      ? v.map((x) => `• ${scalar(x)}`).join('\n')
      : v.map((x, i) => `${i + 1}. ${typeof x === 'object' && x ? render(x).replace(/\n/g, '\n   ') : scalar(x)}`).join('\n')
  }
  if (v && typeof v === 'object') return stringify(v, { lineWidth: 0 }).trim()
  return scalar(v)
}

/** A readable view of an agent message that is wholly JSON or YAML; null for ordinary text. */
export function formatBody(body: string | null | undefined): FormattedBody | null {
  const value = parseStructured(body)
  if (!value || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (!keys.length) return null
  const key = HEADLINE.find((k) => typeof record[k] === 'string' && (record[k] as string).length > 0)
  const rows = keys
    .filter((k) => k !== key)
    .map((k) => ({
      label: k === 'needs_input' ? 'Needs your input' : label(k),
      value: k === 'needs_input' ? scalar((record[k] as { title?: string })?.title ?? 'Input requested') : render(record[k])
    }))
  return { headline: key ? (record[key] as string) : null, rows }
}

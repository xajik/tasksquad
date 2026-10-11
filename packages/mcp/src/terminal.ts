import type { TaskSquadApi } from './api.js'

// Live terminal access over the worker's TerminalRelay WebSocket — the same
// protocol as packages/portal/src/components/LiveTerminal.tsx: binary frames
// carry raw PTY bytes; we send binary JSON {t:'i', d:<base64 utf-8>} for input.

export const SPECIAL_KEYS = {
  enter: '\r',
  escape: '\x1b',
  tab: '\t',
  backspace: '\x7f',
  ctrl_c: '\x03',
  ctrl_d: '\x04',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
} as const
export type SpecialKey = keyof typeof SPECIAL_KEYS

// stripAnsi turns PTY output into readable text: drops CSI/OSC/charset escape
// sequences and bare carriage returns, keeps newlines.
export function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_=>]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
}

export function inputFrame(data: string): Uint8Array {
  let binary = ''
  for (const byte of new TextEncoder().encode(data)) binary += String.fromCharCode(byte)
  return new TextEncoder().encode(JSON.stringify({ t: 'i', d: btoa(binary) }))
}

export interface TerminalOptions {
  input?: string
  waitMs: number
  maxChars: number
  fetchImpl?: typeof fetch
}

export async function useTerminal(api: TaskSquadApi, sessionId: string, opts: TerminalOptions): Promise<string> {
  const { ticket } = await api.terminalTicket(sessionId)
  const doFetch = opts.fetchImpl ?? ((i: RequestInfo, init?: RequestInit) => fetch(i, init))
  const res = await doFetch(api.terminalUrl(sessionId, ticket, true), { headers: { Upgrade: 'websocket' } })
  const ws = (res as Response & { webSocket?: WebSocket | null }).webSocket
  if (!ws) throw new Error(`Live terminal unavailable (HTTP ${res.status}). The session may have ended.`)
  ws.accept()

  const decoder = new TextDecoder()
  let raw = ''
  let closed = false
  ws.addEventListener('message', (e: MessageEvent) => {
    if (typeof e.data === 'string') return // __ping__
    raw += decoder.decode(e.data as ArrayBuffer, { stream: true })
  })
  ws.addEventListener('close', () => { closed = true })

  if (opts.input) {
    // Let the replayed tail arrive first so the output reads before → after.
    await sleep(Math.min(400, opts.waitMs))
    if (!closed) ws.send(inputFrame(opts.input))
  }
  await sleep(opts.waitMs)
  try { ws.close(1000, 'done') } catch { /* already closed */ }

  const text = stripAnsi(raw).trimEnd()
  return text.length > opts.maxChars ? '…' + text.slice(-opts.maxChars) : text
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

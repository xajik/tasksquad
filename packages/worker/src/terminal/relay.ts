// TerminalRelay — Cloudflare Durable Object that bridges the daemon PTY output
// to one or more browser clients in real time.
//
// Protocol:
//   Daemon  → relay: raw binary frames (PTY output) — fan-out to viewers
//   Browser → relay: binary-encoded JSON control frames — forwarded to daemon only
//     { t: 'i', d: '<base64>' }          stdin keystrokes
//     { t: 'r', c: <cols>, r: <rows> }   terminal resize
//
// The relay identifies the daemon connection by the presence of the X-TSQ-Agent
// request header (the same auth token used in index.ts).
//
// A capped tail of recent PTY output is kept in Durable Object storage so a
// browser viewer that (re)connects with ?replay=1 — i.e. a genuine mount, not
// a same-session drop/retry whose xterm buffer already has that content — can
// be caught up instead of seeing a blank terminal.
export const BUFFER_CAP_BYTES = 64 * 1024
const FLUSH_INTERVAL_MS = 250
const BUFFER_TTL_MS = 24 * 60 * 60 * 1000

export function appendCapped(buffer: Uint8Array, chunk: Uint8Array, cap: number): Uint8Array {
  const combined = new Uint8Array(buffer.length + chunk.length)
  combined.set(buffer, 0)
  combined.set(chunk, buffer.length)
  return combined.length > cap ? combined.slice(combined.length - cap) : combined
}

export function shouldReplay(replayParam: string | null, bufferLength: number): boolean {
  return replayParam === '1' && bufferLength > 0
}

export class TerminalRelay implements DurableObject {
  private daemonWs: WebSocket | null = null
  private viewers: Set<WebSocket> = new Set()
  private buffer: Uint8Array = new Uint8Array(0)
  private lastFlush = 0
  private hydrated: Promise<void>

  constructor(private state: DurableObjectState) {
    this.hydrated = state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<ArrayBuffer>('buffer')
      if (stored) this.buffer = new Uint8Array(stored)
    })
  }

  async fetch(request: Request): Promise<Response> {
    await this.hydrated

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }
    const { 0: client, 1: server } = new WebSocketPair()
    server.accept()

    const isDaemon = request.headers.has('X-TSQ-Agent')

    if (isDaemon) {
      this.daemonWs = server

      server.addEventListener('message', (e) => {
        const data = e.data as ArrayBuffer | string
        if (typeof data === 'string') return // drop unexpected text frames

        this.buffer = appendCapped(this.buffer, new Uint8Array(data), BUFFER_CAP_BYTES)
        const now = Date.now()
        if (now - this.lastFlush > FLUSH_INTERVAL_MS) {
          this.lastFlush = now
          this.flushBuffer()
        }

        // Fan-out PTY output to all connected viewers
        for (const v of [...this.viewers]) {
          try { v.send(data) } catch { this.viewers.delete(v) }
        }
      })

      const onClose = () => {
        if (this.daemonWs === server) this.daemonWs = null
        this.flushBuffer()
        this.state.storage.setAlarm(Date.now() + BUFFER_TTL_MS).catch(() => {})
      }
      server.addEventListener('close', onClose)
      server.addEventListener('error', onClose)
    } else {
      const replayParam = new URL(request.url).searchParams.get('replay')
      if (shouldReplay(replayParam, this.buffer.length)) {
        try { server.send(this.buffer) } catch { /* best-effort */ }
      }
      this.viewers.add(server)

      server.addEventListener('message', (e) => {
        const data = e.data as ArrayBuffer | string
        if (typeof data === 'string') return // drop unexpected text frames

        // Forward binary control frames (stdin, resize) to daemon only
        if (this.daemonWs && this.daemonWs.readyState === WebSocket.READY_STATE_OPEN) {
          try { this.daemonWs.send(data) } catch { this.daemonWs = null }
        }
      })

      const onClose = () => { this.viewers.delete(server) }
      server.addEventListener('close', onClose)
      server.addEventListener('error', onClose)
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  async alarm(): Promise<void> {
    await this.state.storage.delete('buffer')
  }

  private flushBuffer(): void {
    void this.state.storage.put('buffer', this.buffer.buffer).catch(() => {})
  }
}

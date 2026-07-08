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
export class TerminalRelay implements DurableObject {
  private daemonWs: WebSocket | null = null
  private viewers: Set<WebSocket> = new Set()

  async fetch(request: Request): Promise<Response> {
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

        // Fan-out PTY output to all connected viewers
        for (const v of [...this.viewers]) {
          try { v.send(data) } catch { this.viewers.delete(v) }
        }
      })

      const onClose = () => { if (this.daemonWs === server) this.daemonWs = null }
      server.addEventListener('close', onClose)
      server.addEventListener('error', onClose)
    } else {
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
}

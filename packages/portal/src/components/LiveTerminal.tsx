import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '@/lib/api'

const WS_BASE = (import.meta.env.VITE_API_BASE_URL as string)
  .replace('https://', 'wss://')
  .replace('http://', 'ws://')

const MAX_RETRIES = 6 // exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s ≈ 63s total

export function LiveTerminal({ sessionId }: { sessionId: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    let ws: WebSocket | undefined
    let disposed = false
    let retryCount = 0

    const term = new Terminal({
      convertEol: true,
      scrollback: 5000,
      theme: { background: '#0F1117' },
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(ref.current)
    fitAddon.fit()

    // Forward keystrokes to the relay → daemon → tmux (binary frame so relay routes it)
    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(JSON.stringify({ t: 'i', d: btoa(data) })))
      }
    })

    // Resize terminal and notify daemon when container dimensions change
    const ro = new ResizeObserver(() => {
      fitAddon.fit()
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(JSON.stringify({ t: 'r', c: term.cols, r: term.rows })))
      }
    })
    ro.observe(ref.current)

    async function connect() {
      if (disposed) return
      try {
        const { ticket } = await api.terminal.ticket(sessionId)
        if (disposed) return

        ws = new WebSocket(`${WS_BASE}/terminal/${sessionId}?ticket=${ticket}`)
        ws.binaryType = 'arraybuffer'

        ws.onmessage = (e) => {
          if (typeof e.data === 'string') return // ignore __ping__
          term.write(new Uint8Array(e.data as ArrayBuffer))
        }

        ws.onopen = () => {
          retryCount = 0
          // Send initial terminal dimensions so tmux starts at the right size
          fitAddon.fit()
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(new TextEncoder().encode(JSON.stringify({ t: 'r', c: term.cols, r: term.rows })))
          }
        }

        ws.onclose = () => {
          if (!disposed) {
            if (retryCount < MAX_RETRIES) {
              const delay = Math.min(1000 * 2 ** retryCount, 30_000)
              retryCount++
              term.writeln(`\r\n\x1b[33m[reconnecting in ${delay / 1000}s…]\x1b[0m`)
              setTimeout(connect, delay)
            } else {
              term.writeln('\r\n\x1b[2m[session ended]\x1b[0m')
            }
          }
        }
      } catch {
        if (!disposed) term.writeln('\r\n\x1b[31m[failed to connect — auth error]\x1b[0m')
      }
    }

    connect()

    return () => {
      disposed = true
      ro.disconnect()
      ws?.close()
      term.dispose()
    }
  }, [sessionId])

  return (
    <div
      ref={ref}
      style={{ height: '100%', minHeight: 300, borderRadius: 8, overflow: 'hidden' }}
    />
  )
}

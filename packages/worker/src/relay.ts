export class AgentRelay implements DurableObject {
  private state: DurableObjectState
  private clients: Set<ReadableStreamDefaultController<Uint8Array>>

  constructor(state: DurableObjectState) {
    this.state = state
    this.clients = new Set()
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/connect') {
      return this.handleConnect()
    }

    if (url.pathname === '/push' && req.method === 'POST') {
      return this.handlePush(req)
    }

    if (url.pathname === '/viewers') {
      return Response.json({ count: this.clients.size })
    }

    return new Response('Not found', { status: 404 })
  }

  private handleConnect(): Response {
    const encoder = new TextEncoder()
    let controller: ReadableStreamDefaultController<Uint8Array>

    const stream = new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        controller = ctrl
        this.clients.add(controller)
        this.updateViewerCount()

        // Send initial connection confirmation
        ctrl.enqueue(encoder.encode('data: {"type":"connected"}\n\n'))
      },
      cancel: () => {
        this.clients.delete(controller)
        this.updateViewerCount()
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }

  private async handlePush(req: Request): Promise<Response> {
    const body = await req.json<{ type: string; lines: string[] }>()
    const encoder = new TextEncoder()

    const dead: ReadableStreamDefaultController<Uint8Array>[] = []
    for (const ctrl of this.clients) {
      try {
        const payload = JSON.stringify({ type: body.type, text: body.lines.join('\n') })
        ctrl.enqueue(encoder.encode(`data: ${payload}\n\n`))
      } catch {
        dead.push(ctrl)
      }
    }
    for (const ctrl of dead) this.clients.delete(ctrl)
    this.updateViewerCount()

    return Response.json({ ok: true })
  }

  private updateViewerCount(): void {
    // Persist viewer count so daemon can poll it
    void this.state.storage.put('viewer_count', this.clients.size)
  }
}

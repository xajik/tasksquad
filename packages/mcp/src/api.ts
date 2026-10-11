// Typed client for the TaskSquad worker API. Paths and bodies mirror
// packages/portal/src/lib/api.ts — keep the two in sync.

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, path: string) {
    super(`TaskSquad API ${status} on ${path}: ${describe(body)}`)
  }
}

function describe(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; message?: unknown }
    if (typeof b.error === 'string') return b.error
    if (typeof b.message === 'string') return b.message
  }
  return typeof body === 'string' && body ? body.slice(0, 300) : 'request failed'
}

export interface ImageInput {
  filename: string
  mime_type: string
  data: Uint8Array
}

export type SaveTokens = { enabled: boolean; level: 'lite' | 'full' | 'ultra' }
export type LibraryKind = 'skills' | 'sub-agents' | 'commands'
export type MemoryCategory = 'personal' | 'preferences' | 'structure' | 'architecture' | 'events'

type Json = Record<string, unknown>

export class TaskSquadApi {
  constructor(
    private base: string,
    private token: string,
    private fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async request<T = Json>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.send(path, init, { 'Content-Type': 'application/json' })
    if (res.status === 204) return {} as T
    const text = await res.text()
    if (!text) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      return text as T
    }
  }

  async text(path: string): Promise<string> {
    return (await this.send(path, {})).text()
  }

  async blob(path: string): Promise<{ data: Uint8Array; mimeType: string }> {
    const res = await this.send(path, {})
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get('Content-Type')?.split(';')[0] ?? 'application/octet-stream',
    }
  }

  private async send(path: string, init: RequestInit, extra: Record<string, string> = {}): Promise<Response> {
    const isForm = init.body instanceof FormData
    const res = await this.fetchImpl(this.base + path, {
      ...init,
      headers: {
        ...(isForm ? {} : extra),
        Authorization: `Bearer ${this.token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      let body: unknown = raw
      try { body = JSON.parse(raw) } catch { /* keep text */ }
      throw new ApiError(res.status, body, path)
    }
    return res
  }

  private post<T = Json>(path: string, body?: unknown, method = 'POST') {
    return this.request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
  }

  private form<T = Json>(path: string, fields: Record<string, string | undefined>, images: ImageInput[]) {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.set(k, v)
    for (const img of images) form.append('images', new File([img.data], img.filename, { type: img.mime_type }))
    return this.request<T>(path, { method: 'POST', body: form })
  }

  // ── account ────────────────────────────────────────────────────────────
  me() { return this.request<{ id: string; email: string; plan: 'free' | 'pro' }>('/me') }
  stats(teamId: string, p: { from: number; to: number; tzOffsetMinutes?: number; agentId?: string }) {
    const q = new URLSearchParams({ from: String(p.from), to: String(p.to), tz: String(p.tzOffsetMinutes ?? 0) })
    if (p.agentId) q.set('agent_id', p.agentId)
    return this.request(`/teams/${enc(teamId)}/stats?${q}`)
  }

  // ── projects (teams) ───────────────────────────────────────────────────
  listTeams() { return this.request<{ teams: Json[] }>('/teams') }
  createTeam(name: string) { return this.post('/teams', { name }) }
  updateTeam(teamId: string, body: { learn_from_session?: boolean; memory_enabled?: boolean }) {
    return this.post(`/teams/${enc(teamId)}`, body, 'PATCH')
  }
  listMembers(teamId: string) { return this.request<{ members: Json[] }>(`/teams/${enc(teamId)}/members`) }

  // ── agents ─────────────────────────────────────────────────────────────
  listAgents(teamId: string) { return this.request<{ agents: Json[] }>(`/teams/${enc(teamId)}/agents`) }
  createAgent(teamId: string, body: { name: string; role?: string }) { return this.post(`/teams/${enc(teamId)}/agents`, body) }
  updateAgentRole(teamId: string, agentId: string, role: string) {
    return this.post(`/teams/${enc(teamId)}/agents/${enc(agentId)}`, { role }, 'PATCH')
  }
  resetAgent(teamId: string, agentId: string) { return this.post(`/teams/${enc(teamId)}/agents/${enc(agentId)}/reset`) }
  pauseAgent(teamId: string, agentId: string, paused: boolean) {
    return this.post(`/teams/${enc(teamId)}/agents/${enc(agentId)}/pause`, { paused })
  }

  // ── tasks ──────────────────────────────────────────────────────────────
  listTasks(teamId: string, f: { agentId?: string; status?: string } = {}) {
    const q = new URLSearchParams({ team_id: teamId })
    if (f.agentId) q.set('agent_id', f.agentId)
    if (f.status) q.set('status', f.status)
    return this.request<{ tasks: Json[] }>(`/tasks?${q}`)
  }
  getTask(taskId: string) { return this.request(`/tasks/${enc(taskId)}`) }
  createTask(body: {
    team_id: string; agent_id: string; subject: string; body?: string; scheduled_at?: number
    auto_close?: boolean; save_tokens?: SaveTokens; close_steps?: string[]
  }, images: ImageInput[] = []) {
    if (images.length === 0) return this.post<{ id: string; status: string }>('/tasks', body)
    return this.form<{ id: string; status: string }>('/tasks', {
      team_id: body.team_id,
      agent_id: body.agent_id,
      subject: body.subject,
      body: body.body,
      scheduled_at: body.scheduled_at ? String(body.scheduled_at) : undefined,
      auto_close: body.auto_close === undefined ? undefined : String(body.auto_close),
      save_tokens: body.save_tokens ? JSON.stringify(body.save_tokens) : undefined,
      close_steps: body.close_steps ? JSON.stringify(body.close_steps) : undefined,
    }, images)
  }
  updateTaskSettings(taskId: string, settings: { save_tokens?: SaveTokens }) {
    return this.post(`/tasks/${enc(taskId)}/settings`, settings, 'PATCH')
  }
  gradeTask(taskId: string, grade: number | null) { return this.post(`/tasks/${enc(taskId)}/grade`, { grade }, 'PATCH') }
  closeTask(taskId: string) { return this.post(`/tasks/${enc(taskId)}/close`) }
  forwardTask(taskId: string, agentId: string, instructions?: string) {
    return this.post<{ task_id: string }>(`/tasks/${enc(taskId)}/forward`, { agent_id: agentId, instructions })
  }

  // ── messages ───────────────────────────────────────────────────────────
  listMessages(taskId: string) { return this.request<{ messages: Json[] }>(`/tasks/${enc(taskId)}/messages`) }
  transcript(taskId: string, msgId: string) { return this.text(`/tasks/${enc(taskId)}/messages/${enc(msgId)}/transcript`) }
  attachment(taskId: string, msgId: string, attId: string) {
    return this.blob(`/tasks/${enc(taskId)}/messages/${enc(msgId)}/attachments/${enc(attId)}`)
  }
  createMessage(taskId: string, body: string, scheduledAt?: number, images: ImageInput[] = []) {
    const path = `/tasks/${enc(taskId)}/messages`
    if (images.length === 0) return this.post(path, { body, scheduled_at: scheduledAt })
    return this.form(path, { body, scheduled_at: scheduledAt ? String(scheduledAt) : undefined }, images)
  }
  updateMessage(taskId: string, msgId: string, body?: string, scheduledAt?: number) {
    return this.post(`/tasks/${enc(taskId)}/messages/${enc(msgId)}`, { body, scheduled_at: scheduledAt }, 'PUT')
  }
  deleteMessage(taskId: string, msgId: string) {
    return this.request(`/tasks/${enc(taskId)}/messages/${enc(msgId)}`, { method: 'DELETE' })
  }
  gradeMessage(taskId: string, msgId: string, grade: number | null) {
    return this.post(`/tasks/${enc(taskId)}/messages/${enc(msgId)}/grade`, { grade }, 'PATCH')
  }

  // ── conveyors ──────────────────────────────────────────────────────────
  listConveyors(teamId: string) { return this.request<{ conveyors: Json[] }>(`/teams/${enc(teamId)}/conveyors`) }
  createConveyor(teamId: string, body: Json) { return this.post(`/teams/${enc(teamId)}/conveyors`, body) }
  updateConveyor(teamId: string, conveyorId: string, body: Json) {
    return this.post(`/teams/${enc(teamId)}/conveyors/${enc(conveyorId)}`, body, 'PUT')
  }
  conveyorTasks(teamId: string, conveyorId: string) {
    return this.request<{ tasks: Json[] }>(`/teams/${enc(teamId)}/conveyors/${enc(conveyorId)}/tasks`)
  }

  // ── notes ──────────────────────────────────────────────────────────────
  listNotes(teamId: string, p: { archived?: boolean; limit?: number; offset?: number } = {}) {
    const q = new URLSearchParams()
    if (p.archived) q.set('archived', 'true')
    if (p.limit != null) q.set('limit', String(p.limit))
    if (p.offset != null) q.set('offset', String(p.offset))
    const qs = q.toString()
    return this.request(`/teams/${enc(teamId)}/notes${qs ? '?' + qs : ''}`)
  }
  getNote(teamId: string, noteId: string) { return this.request(`/teams/${enc(teamId)}/notes/${enc(noteId)}`) }
  createNote(teamId: string, body: { title: string; content: string; tags?: string[] }) {
    return this.post(`/teams/${enc(teamId)}/notes`, body)
  }
  updateNote(teamId: string, noteId: string, body: { title?: string; content?: string; tags?: string[] }) {
    return this.post(`/teams/${enc(teamId)}/notes/${enc(noteId)}`, body, 'PUT')
  }
  archiveNote(teamId: string, noteId: string, archived: boolean) {
    return this.post(`/teams/${enc(teamId)}/notes/${enc(noteId)}/archive`, undefined, archived ? 'POST' : 'DELETE')
  }
  listNoteComments(teamId: string, noteId: string) {
    return this.request<{ comments: Json[] }>(`/teams/${enc(teamId)}/notes/${enc(noteId)}/comments`)
  }
  createNoteComment(teamId: string, noteId: string, content: string) {
    return this.post(`/teams/${enc(teamId)}/notes/${enc(noteId)}/comments`, { content })
  }
  convertNote(teamId: string, noteId: string, body: { agent_id: string; include_comments?: boolean; instructions?: string; auto_close?: boolean }) {
    return this.post<{ task_id: string }>(`/teams/${enc(teamId)}/notes/${enc(noteId)}/convert`, body)
  }
  critiqueNote(teamId: string, noteId: string, body: { agent_id: string; context?: string; include_comments?: boolean }) {
    return this.post<{ task_id: string }>(`/teams/${enc(teamId)}/notes/${enc(noteId)}/critique`, body)
  }
  noteLinkedTasks(teamId: string, noteId: string) {
    return this.request<{ tasks: Json[] }>(`/teams/${enc(teamId)}/notes/${enc(noteId)}/tasks`)
  }

  // ── library: skills / sub-agents / commands ───────────────────────────
  listLibrary(teamId: string, kind: LibraryKind) { return this.request(`/teams/${enc(teamId)}/${kind}`) }
  getLibraryItem(teamId: string, kind: LibraryKind, id: string) { return this.request(`/teams/${enc(teamId)}/${kind}/${enc(id)}`) }
  createLibraryItem(teamId: string, kind: LibraryKind, body: { name: string; description: string; content: string; auto_install?: boolean }) {
    return this.post(`/teams/${enc(teamId)}/${kind}`, body)
  }
  updateLibraryItem(teamId: string, kind: LibraryKind, id: string, body: { name?: string; description?: string; content?: string; auto_install?: boolean }) {
    return this.post(`/teams/${enc(teamId)}/${kind}/${enc(id)}`, body, 'PUT')
  }

  // ── memory ─────────────────────────────────────────────────────────────
  listMemory(teamId: string, category?: MemoryCategory) {
    return this.request(`/teams/${enc(teamId)}/memory${category ? `?category=${category}` : ''}`)
  }
  getMemory(teamId: string, memoryId: string) { return this.request(`/teams/${enc(teamId)}/memory/${enc(memoryId)}`) }
  rollups(teamId: string, period: 'daily' | 'weekly') { return this.request(`/teams/${enc(teamId)}/rollups?period=${period}`) }
  listTags(teamId: string) { return this.request(`/teams/${enc(teamId)}/tags`) }

  // ── planners ───────────────────────────────────────────────────────────
  listPlanners(teamId: string) { return this.request(`/teams/${enc(teamId)}/planners`) }
  getPlanner(teamId: string, id: string) { return this.request(`/teams/${enc(teamId)}/planners/${enc(id)}`) }
  createPlanner(teamId: string, body: Json) { return this.post(`/teams/${enc(teamId)}/planners`, body) }
  updatePlanner(teamId: string, id: string, body: { paused?: boolean; planner_verdict?: 0 | 1 | null }) {
    return this.post(`/teams/${enc(teamId)}/planners/${enc(id)}`, body, 'PATCH')
  }

  // ── portals & live terminal ────────────────────────────────────────────
  listPortals(teamId: string) { return this.request(`/portals?team_id=${enc(teamId)}`) }
  getPortal(portalId: string) { return this.request(`/portals/${enc(portalId)}`) }
  createPortal(teamId: string, agentId: string) { return this.post('/portals', { team_id: teamId, agent_id: agentId }) }
  closePortal(portalId: string) { return this.post(`/portals/${enc(portalId)}/close`) }
  terminalTicket(sessionId: string) { return this.post<{ ticket: string }>('/terminal/ticket', { session_id: sessionId }) }
  terminalUrl(sessionId: string, ticket: string, replay: boolean) {
    // Workers open outbound WebSockets with fetch() + Upgrade on an http(s) URL.
    return `${this.base}/terminal/${enc(sessionId)}?ticket=${enc(ticket)}&replay=${replay ? 1 : 0}`
  }
}

function enc(s: string) { return encodeURIComponent(s) }

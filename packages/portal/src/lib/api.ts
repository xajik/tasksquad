import { getToken } from './firebase'
import { trackEvent } from './analytics'
import { MessageType } from './messageTypes'

const BASE = import.meta.env.VITE_API_BASE_URL

function del(path: string) {
  return request<{ ok: boolean }>(path, { method: 'DELETE' })
}

async function request<T>(path: string, init: RequestInit = {}, rawText = false): Promise<T> {
  const token = await getToken()
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token ? `Bearer ${token}` : '',
      ...init.headers,
    },
  })
  if (!res.ok) {
    const err = await res.json()
    trackEvent('api_error', { path, status: res.status, error: err.error || err.message || 'Unknown' })
    throw err
  }
  return rawText ? res.text() as Promise<T> : res.json() as Promise<T>
}

export const api = {
  me: () => request<UserProfile>('/me'),
  teams: {
    list: () => request<{ teams: Team[] }>('/teams'),
    create: (name: string) =>
      request<{ id: string; name: string }>('/teams', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    updateSettings: (teamId: string, body: { learn_from_session?: boolean }) =>
      request<{ ok: boolean }>(`/teams/${teamId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    delete: (teamId: string) =>
      request<{ ok: boolean }>(`/teams/${teamId}`, { method: 'DELETE' }),
  },
  members: {
    list: (teamId: string) =>
      request<{ members: Member[] }>(`/teams/${teamId}/members`),
    add: (teamId: string, email: string) =>
      request<{ ok: boolean }>(`/teams/${teamId}/members`, {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
    remove: (teamId: string, userId: string) =>
      del(`/teams/${teamId}/members/${userId}`),
  },
  agents: {
    list: (teamId: string) =>
      request<{ agents: Agent[] }>(`/teams/${teamId}/agents`),
    create: (teamId: string, body: { name: string; role?: string }) =>
      request<Agent>(`/teams/${teamId}/agents`, { method: 'POST', body: JSON.stringify(body) }),
    updateRole: (teamId: string, agentId: string, role: string) =>
      request<{ ok: boolean; role: string | null }>(`/teams/${teamId}/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    createToken: (teamId: string, agentId: string, label: string) =>
      request<{ id: string; token: string; label: string }>(`/teams/${teamId}/tokens`, {
        method: 'POST',
        body: JSON.stringify({ label, agent_id: agentId }),
      }),
    reset: (teamId: string, agentId: string) =>
      request<{ ok: boolean }>(`/teams/${teamId}/agents/${agentId}/reset`, { method: 'POST' }),
    pause: (teamId: string, agentId: string, paused: boolean) =>
      request<{ ok: boolean; paused: boolean }>(`/teams/${teamId}/agents/${agentId}/pause`, {
        method: 'POST',
        body: JSON.stringify({ paused }),
      }),
    delete: (teamId: string, agentId: string) =>
      request<{ ok: boolean }>(`/teams/${teamId}/agents/${agentId}`, { method: 'DELETE' }),
  },
  tasks: {
    list: (teamId: string) => request<{ tasks: Task[] }>(`/tasks?team_id=${teamId}`),
    get: (id: string) => request<Task>(`/tasks/${id}`),
    create: (body: { agent_id: string; subject: string; team_id: string; body?: string; scheduled_at?: number; auto_close?: boolean; save_tokens?: { enabled: boolean; level: 'lite' | 'full' | 'ultra' }; close_steps?: string[] }) =>
      request<{ id: string; status: string }>('/tasks', { method: 'POST', body: JSON.stringify(body) }),
    update: (taskId: string, body: { status: string }) =>
      request<{ ok: boolean }>(`/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(body) }),
    updateSettings: (taskId: string, settings: TaskSettings) =>
      request<{ ok: boolean }>(`/tasks/${taskId}/settings`, { method: 'PATCH', body: JSON.stringify(settings) }),
    grade: (taskId: string, grade: number | null) =>
      request<{ ok: boolean }>(`/tasks/${taskId}/grade`, { method: 'PATCH', body: JSON.stringify({ grade }) }),
    close: (taskId: string) =>
      request<{ ok: boolean }>(`/tasks/${taskId}/close`, { method: 'POST' }),
    delete: (taskId: string) =>
      request<{ ok: boolean }>(`/tasks/${taskId}`, { method: 'DELETE' }),
    logs: (taskId: string) => request<{ logs: TaskLog[] }>(`/tasks/${taskId}/logs`),
    forward: (taskId: string, agentId: string, instructions?: string) =>
      request<{ task_id: string }>(`/tasks/${taskId}/forward`, {
        method: 'POST',
        body: JSON.stringify({ agent_id: agentId, instructions }),
      }),
  },
  conveyors: {
    list: (teamId: string) => request<{ conveyors: Conveyor[] }>(`/teams/${teamId}/conveyors`),
    create: (teamId: string, body: {
      agent_id: string;
      subject: string;
      body: string;
      frequency: string;
      hour: number;
      minute?: number;
      day_of_week?: number;
      day_of_month?: number;
      repeat_count?: number;
      end_date?: number;
      timezone?: string;
      auto_close?: boolean;
    }) =>
      request<{ id: string; next_run_at: number }>(`/teams/${teamId}/conveyors`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (teamId: string, conveyorId: string, body: {
      agent_id?: string;
      subject?: string;
      body?: string;
      frequency?: string;
      hour?: number;
      minute?: number;
      day_of_week?: number | null;
      day_of_month?: number | null;
      repeat_count?: number | null;
      end_date?: number | null;
      timezone?: string;
      auto_close?: boolean;
    }) =>
      request<{ id: string; next_run_at: number }>(`/teams/${teamId}/conveyors/${conveyorId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    delete: (teamId: string, conveyorId: string) =>
      del(`/teams/${teamId}/conveyors/${conveyorId}`),
    pause: (teamId: string, conveyorId: string, paused: boolean) =>
      request<{ id: string; next_run_at: number; paused: boolean }>(
        `/teams/${teamId}/conveyors/${conveyorId}`,
        { method: 'PUT', body: JSON.stringify({ paused }) }
      ),
    tasks: (teamId: string, conveyorId: string) =>
      request<{ tasks: Task[] }>(`/teams/${teamId}/conveyors/${conveyorId}/tasks`),
  },
  messages: {
    list: (taskId: string) => request<{ messages: Message[] }>(`/tasks/${taskId}/messages`),
    transcript: (taskId: string, msgId: string) =>
      request<string>(`/tasks/${taskId}/messages/${msgId}/transcript`, {}, true),
    create: (taskId: string, body: string, scheduledAt?: number) =>
      request<Message>(`/tasks/${taskId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body, scheduled_at: scheduledAt }),
      }),
    update: (taskId: string, msgId: string, body?: string, scheduledAt?: number) =>
      request<Message>(`/tasks/${taskId}/messages/${msgId}`, {
        method: 'PUT',
        body: JSON.stringify({ body, scheduled_at: scheduledAt }),
      }),
    delete: (taskId: string, msgId: string) =>
      request<void>(`/tasks/${taskId}/messages/${msgId}`, {
        method: 'DELETE',
      }),
    grade: (taskId: string, msgId: string, grade: number | null) =>
      request<{ ok: boolean }>(`/tasks/${taskId}/messages/${msgId}/grade`, { method: 'PATCH', body: JSON.stringify({ grade }) }),
  },
  notes: {
    list: (teamId: string, params?: { archived?: boolean; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams()
      if (params?.archived) qs.set('archived', 'true')
      if (params?.limit != null) qs.set('limit', String(params.limit))
      if (params?.offset != null) qs.set('offset', String(params.offset))
      const q = qs.toString()
      return request<{ notes: Note[]; total: number; has_more: boolean }>(`/teams/${teamId}/notes${q ? '?' + q : ''}`)
    },
    create: (teamId: string, body: { title: string; content: string; tags?: string[] }) =>
      request<Note>(`/teams/${teamId}/notes`, { method: 'POST', body: JSON.stringify(body) }),
    get: (teamId: string, noteId: string) => request<Note>(`/teams/${teamId}/notes/${noteId}`),
    update: (teamId: string, noteId: string, body: { title?: string; content?: string; tags?: string[] }) =>
      request<{ ok: boolean }>(`/teams/${teamId}/notes/${noteId}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (teamId: string, noteId: string) =>
      del(`/teams/${teamId}/notes/${noteId}`),
    archive: (teamId: string, noteId: string) =>
      request<{ ok: boolean }>(`/teams/${teamId}/notes/${noteId}/archive`, { method: 'POST' }),
    unarchive: (teamId: string, noteId: string) =>
      request<{ ok: boolean }>(`/teams/${teamId}/notes/${noteId}/archive`, { method: 'DELETE' }),
    listComments: (teamId: string, noteId: string) =>
      request<{ comments: NoteComment[] }>(`/teams/${teamId}/notes/${noteId}/comments`),
    createComment: (teamId: string, noteId: string, content: string) =>
      request<NoteComment>(`/teams/${teamId}/notes/${noteId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      }),
    deleteComment: (teamId: string, noteId: string, commentId: string) =>
      request<void>(`/teams/${teamId}/notes/${noteId}/comments/${commentId}`, { method: 'DELETE' }),
    convertToInbox: (teamId: string, noteId: string, body: { agent_id: string; include_comments?: boolean; instructions?: string; auto_close?: boolean }) =>
      request<{ task_id: string }>(`/teams/${teamId}/notes/${noteId}/convert`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    critique: (teamId: string, noteId: string, body: { agent_id: string; context?: string; include_comments?: boolean }) =>
      request<{ task_id: string }>(`/teams/${teamId}/notes/${noteId}/critique`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listLinkedTasks: (teamId: string, noteId: string) =>
      request<{ tasks: LinkedTask[] }>(`/teams/${teamId}/notes/${noteId}/tasks`),
  },
  skills: {
    list: (teamId: string) => request<{ skills: Skill[] }>(`/teams/${teamId}/skills`),
    get: (teamId: string, skillId: string) => request<Skill>(`/teams/${teamId}/skills/${skillId}`),
    create: (teamId: string, body: { name: string; description: string; content: string; auto_install?: boolean }) =>
      request<{ id: string; name: string; etag: string }>(`/teams/${teamId}/skills`, { method: 'POST', body: JSON.stringify(body) }),
    update: (teamId: string, skillId: string, body: { name?: string; description?: string; content?: string; auto_install?: boolean }) =>
      request<{ ok: boolean }>(`/teams/${teamId}/skills/${skillId}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (teamId: string, skillId: string) => del(`/teams/${teamId}/skills/${skillId}`),
  },
  subAgents: {
    list: (teamId: string) => request<{ sub_agents: SubAgent[] }>(`/teams/${teamId}/sub-agents`),
    get: (teamId: string, id: string) => request<SubAgent>(`/teams/${teamId}/sub-agents/${id}`),
    create: (teamId: string, body: { name: string; description: string; content: string; auto_install?: boolean }) =>
      request<{ id: string; name: string; etag: string }>(`/teams/${teamId}/sub-agents`, { method: 'POST', body: JSON.stringify(body) }),
    update: (teamId: string, id: string, body: { name?: string; description?: string; content?: string; auto_install?: boolean }) =>
      request<{ ok: boolean }>(`/teams/${teamId}/sub-agents/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (teamId: string, id: string) => del(`/teams/${teamId}/sub-agents/${id}`),
  },
  commands: {
    list: (teamId: string) => request<{ commands: Command[] }>(`/teams/${teamId}/commands`),
    get: (teamId: string, id: string) => request<Command>(`/teams/${teamId}/commands/${id}`),
    create: (teamId: string, body: { name: string; description: string; content: string; auto_install?: boolean }) =>
      request<{ id: string; name: string; etag: string }>(`/teams/${teamId}/commands`, { method: 'POST', body: JSON.stringify(body) }),
    update: (teamId: string, id: string, body: { name?: string; description?: string; content?: string; auto_install?: boolean }) =>
      request<{ ok: boolean }>(`/teams/${teamId}/commands/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (teamId: string, id: string) => del(`/teams/${teamId}/commands/${id}`),
  },
  planners: {
    list: (teamId: string) =>
      request<{ planners: Planner[] }>(`/teams/${teamId}/planners`),
    get: (teamId: string, id: string) =>
      request<Planner>(`/teams/${teamId}/planners/${id}`),
    create: (teamId: string, body: {
      name: string
      description?: string
      max_retries?: number
      auto_close?: boolean
      default_sub_agent_id?: string
      default_harness_agent_id?: string
      phases: Array<{
        name: string
        sub_agent_id?: string
        harness_agent_id?: string
        max_retries?: number
        auto_close?: boolean
      }>
    }) =>
      request<{ id: string; status: PlannerStatus; first_task_id: string | null }>(
        `/teams/${teamId}/planners`, { method: 'POST', body: JSON.stringify(body) },
      ),
    update: (teamId: string, id: string, body: { paused?: boolean; planner_verdict?: 0 | 1 | null }) =>
      request<{ ok: boolean }>(`/teams/${teamId}/planners/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (teamId: string, id: string) =>
      del(`/teams/${teamId}/planners/${id}`),
  },
  portals: {
    list: (teamId: string) =>
      request<{ portals: Portal[] }>(`/portals?team_id=${teamId}`),
    get: (portalId: string) =>
      request<Portal>(`/portals/${portalId}`),
    create: (body: { team_id: string; agent_id: string }) =>
      request<{ id: string; status: string }>('/portals', { method: 'POST', body: JSON.stringify(body) }),
    close: (portalId: string) =>
      request<{ ok: boolean }>(`/portals/${portalId}/close`, { method: 'POST' }),
  },
  terminal: {
    ticket: (sessionId: string) =>
      request<{ ticket: string }>('/terminal/ticket', {
        method: 'POST',
        body: JSON.stringify({ session_id: sessionId }),
      }),
  },
}

export interface UserProfile {
  id: string
  email: string
  plan: 'free' | 'pro'
}

export interface Member {
  id: string
  email: string
  role: string
  joined_at: number
}

export interface Agent {
  id: string
  name: string
  role: string | null
  status: string
  last_seen: number | null
  created_at: number
  paused: boolean
  reset_pending: boolean
}

export interface Team {
  id: string
  name: string
  role: string
  learn_from_session: boolean
}

export interface Skill {
  id: string
  team_id: string | null
  name: string
  description: string
  content?: string
  author_id: string | null
  etag: string
  is_default: number
  auto_install: number
  created_at: number
  updated_at: number
}

export interface SubAgent {
  id: string
  team_id: string | null
  name: string
  description: string
  content?: string
  author_id: string | null
  etag: string
  is_default: number
  auto_install: number
  version: number
  created_at: number
  updated_at: number
}

export interface Command {
  id: string
  team_id: string | null
  name: string
  description: string
  content?: string
  author_id: string | null
  etag: string
  is_default: number
  auto_install: number
  version: number
  created_at: number
  updated_at: number
}

export interface Conveyor {
  id: string
  team_id: string
  agent_id: string
  sender_id: string
  subject: string
  body: string
  frequency: 'hourly' | 'daily' | 'weekly' | 'monthly'
  hour: number
  minute: number
  day_of_week: number | null
  day_of_month: number | null
  repeat_count: number | null
  repeat_counter: number
  end_date: number | null
  next_run_at: number
  created_at: number
  paused: boolean
  auto_close: boolean
}

export interface TaskSettings {
  save_tokens?: { enabled: boolean; level: 'lite' | 'full' | 'ultra' }
}

export interface Task {
  id: string
  agent_id: string
  sender_id: string
  subject: string
  status: string
  created_at: number
  started_at: number | null
  completed_at: number | null
  first_message_role?: 'user' | 'agent' | 'system'
  first_message_type?: string | null
  scheduled_at?: number | null
  auto_close?: boolean
  settings?: TaskSettings | null
  close_steps?: string[] | null
  close_steps_active_idx?: number
  grade?: number | null
  planner_id?: string | null
  conveyor_id?: string | null
  session_id?: string | null
}

export interface Message {
  id: string
  task_id: string
  sender_id: string | null
  role: 'user' | 'agent' | 'system' | 'supervisor'
  /** Intermediate agent message types. null/undefined = final agent response. */
  type: typeof MessageType[keyof typeof MessageType] | null
  body: string
  /** Structured JSON payload for typed messages (e.g. permission_request). */
  json_payload: string | null
  transcript_key: string | null
  created_at: number
  scheduled_at: number | null
  /** Only present on permission_request messages. */
  interaction_status?: 'pending' | 'resolved' | null
  interaction_response?: string | null
  grade?: number | null
}

export interface Note {
  id: string
  team_id: string
  author_id: string
  title: string
  content: string
  created_at: number
  updated_at: number
  archived_at: number | null
  tags: string[]
}

export interface LinkedTask {
  id: string
  subject: string
  status: string
  created_at: number
  agent_id: string
  agent_name: string | null
}

export interface NoteComment {
  id: string
  note_id: string
  author_id: string | null
  agent_id?: string | null
  agent_name?: string | null
  content: string
  created_at: number
}

export interface Portal {
  id: string
  team_id: string
  agent_id: string
  sender_id: string
  status: 'pending' | 'running' | 'done' | 'failed'
  session_id?: string | null
  created_at: number
  started_at?: number | null
  completed_at?: number | null
}

export interface TaskLog {
  id: string
  level: string
  body: string
  created_at: number
}

export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'reverted'
export type PlannerStatus = 'pending' | 'running' | 'completed' | 'failed'
export type PhaseVerdict = 'approved' | 'rejected'

export type SupervisorStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface Phase {
  phase_id: string
  name: string
  sub_agent_id?: string
  harness_agent_id?: string
  status: PhaseStatus
  task_id?: string
  task_status?: string
  retry_count: number
  max_retries: number
  auto_close: boolean
  user_verdict?: PhaseVerdict
  last_response?: string
  supervisor_task_id?: string
  supervisor_status?: SupervisorStatus
  supervisor_verdict?: 'yes' | 'no'
}

export interface Planner {
  planner_id: string
  name: string
  description?: string
  created_at: string
  status: PlannerStatus
  current_phase_index: number
  max_retries: number
  auto_close: boolean
  paused: boolean
  default_sub_agent_id?: string
  default_harness_agent_id?: string
  planner_verdict?: 0 | 1 | null   // 1 = approved (👍), 0 = rejected (👎)
  phase_count?: number
  phases: Phase[] | null
}

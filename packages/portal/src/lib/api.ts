import { getToken } from './firebase'
import { trackEvent } from './analytics'

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
    create: (body: { agent_id: string; subject: string; team_id: string; body?: string; scheduled_at?: number }) =>
      request<{ id: string; status: string }>('/tasks', { method: 'POST', body: JSON.stringify(body) }),
    update: (taskId: string, body: { status: string }) =>
      request<{ ok: boolean }>(`/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(body) }),
    close: (taskId: string) =>
      request<{ ok: boolean }>(`/tasks/${taskId}/close`, { method: 'POST' }),
    delete: (taskId: string) =>
      request<{ ok: boolean }>(`/tasks/${taskId}`, { method: 'DELETE' }),
    logs: (taskId: string) => request<{ logs: TaskLog[] }>(`/tasks/${taskId}/logs`),
    forward: (taskId: string, agentId: string) =>
      request<{ task_id: string }>(`/tasks/${taskId}/forward`, {
        method: 'POST',
        body: JSON.stringify({ agent_id: agentId }),
      }),
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
}

export interface Message {
  id: string
  task_id: string
  sender_id: string | null
  role: 'user' | 'agent' | 'system'
  /** Intermediate agent message types. null/undefined = final agent response. */
  type: 'thinking' | 'tool_call' | 'tool_result' | 'output' | null
  body: string
  transcript_key: string | null
  created_at: number
  scheduled_at: number | null
}

export interface TaskLog {
  id: string
  level: string
  body: string
  created_at: number
}

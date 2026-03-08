import { getToken } from './firebase'

const BASE = import.meta.env.VITE_API_BASE_URL

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
  if (!res.ok) throw await res.json()
  return rawText ? res.text() as Promise<T> : res.json() as Promise<T>
}

export const api = {
  teams: {
    list: () => request<{ teams: Team[] }>('/teams'),
    create: (name: string) =>
      request<{ id: string; name: string }>('/teams', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
  },
  agents: {
    list: (teamId: string) =>
      request<{ agents: Agent[] }>(`/teams/${teamId}/agents`),
    create: (teamId: string, body: { name: string; command: string; work_dir: string }) =>
      request<Agent>(`/teams/${teamId}/agents`, { method: 'POST', body: JSON.stringify(body) }),
    createToken: (teamId: string, agentId: string, label: string) =>
      request<{ id: string; token: string; label: string }>(`/teams/${teamId}/tokens`, {
        method: 'POST',
        body: JSON.stringify({ label, agent_id: agentId }),
      }),
    delete: (teamId: string, agentId: string) =>
      request<{ ok: boolean }>(`/teams/${teamId}/agents/${agentId}`, { method: 'DELETE' }),
  },
  tasks: {
    list: (teamId: string) => request<{ tasks: Task[] }>(`/tasks?team_id=${teamId}`),
    get: (id: string) => request<Task>(`/tasks/${id}`),
    create: (body: { agent_id: string; subject: string; team_id: string; body?: string }) =>
      request<{ id: string; status: string }>('/tasks', { method: 'POST', body: JSON.stringify(body) }),
    delete: (taskId: string) =>
      request<{ ok: boolean }>(`/tasks/${taskId}`, { method: 'DELETE' }),
    logs: (taskId: string) => request<{ logs: TaskLog[] }>(`/tasks/${taskId}/logs`),
  },
  messages: {
    list: (taskId: string) => request<{ messages: Message[] }>(`/tasks/${taskId}/messages`),
    transcript: (taskId: string, msgId: string) =>
      request<string>(`/tasks/${taskId}/messages/${msgId}/transcript`, {}, true),
    create: (taskId: string, body: string) =>
      request<Message>(`/tasks/${taskId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      }),
  },
}

export interface Agent {
  id: string
  name: string
  command: string
  work_dir: string
  status: string
  last_seen: number | null
  created_at: number
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
  body: string
  transcript_key: string | null
  created_at: number
}

export interface TaskLog {
  id: string
  level: string
  body: string
  created_at: number
}

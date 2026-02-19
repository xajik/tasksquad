import { getToken } from './firebase'

const BASE = import.meta.env.VITE_API_BASE_URL

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  return res.json() as Promise<T>
}

export const api = {
  teams: {
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
    createToken: (teamId: string, label: string) =>
      request<{ id: string; token: string; label: string }>(`/teams/${teamId}/tokens`, {
        method: 'POST',
        body: JSON.stringify({ label }),
      }),
  },
  tasks: {
    list: (q = '') => request<{ tasks: Task[] }>(`/tasks?${q}`),
    get: (id: string) => request<Task>(`/tasks/${id}`),
    create: (body: { agent_id: string; subject: string }) =>
      request<{ id: string; status: string }>('/tasks', { method: 'POST', body: JSON.stringify(body) }),
    logs: (taskId: string) => request<{ logs: TaskLog[] }>(`/tasks/${taskId}/logs`),
  },
  messages: {
    list: (taskId: string) => request<{ messages: Message[] }>(`/tasks/${taskId}/messages`),
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
  created_at: number
}

export interface TaskLog {
  id: string
  level: string
  body: string
  created_at: number
}

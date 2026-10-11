import { z } from 'zod'
import type { ImageInput } from '../api.js'
import { DESTRUCTIVE, READ, WRITE, ok, run, toMillis, type Register } from './util.js'

const taskId = z.string().describe('Task ID (from list_tasks).')
const messageId = z.string().describe('Message ID (from get_task).')
const when = z.string().optional().describe('Deliver later: ISO-8601 date-time (e.g. 2026-10-12T09:00:00Z). Omit to send now.')
const saveTokens = z.object({
  enabled: z.boolean(),
  level: z.enum(['lite', 'full', 'ultra']),
}).optional().describe('Token-saving mode for the agent session.')
const images = z.array(z.object({
  filename: z.string().default('image.png'),
  mime_type: z.string().describe('e.g. image/png, image/jpeg'),
  data_base64: z.string().describe('Base64-encoded image bytes.'),
})).max(10).optional().describe('Optional image attachments.')
const grade = z.union([z.literal(1), z.literal(0), z.null()]).describe('1 = thumbs up, 0 = thumbs down, null = clear.')

function decodeImages(list?: Array<{ filename: string; mime_type: string; data_base64: string }>): ImageInput[] {
  return (list ?? []).map(i => ({
    filename: i.filename,
    mime_type: i.mime_type,
    data: Uint8Array.from(atob(i.data_base64.replace(/^data:[^,]*,/, '')), c => c.charCodeAt(0)),
  }))
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export const registerTasks: Register = (server, { api }) => {
  server.registerTool('list_tasks', {
    title: 'List tasks (inbox)',
    description: 'List tasks in a project inbox, newest first. Each task is an email-style thread between humans and one agent. Optionally filter by agent or status (e.g. pending, scheduled, in_progress, waiting_input, done, failed, closed).',
    inputSchema: {
      team_id: z.string().describe('Project ID (from list_projects).'),
      agent_id: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(50),
    },
    annotations: READ,
  }, ({ team_id, agent_id, status, limit }) => run(async () => {
    const { tasks } = await api.listTasks(team_id, { agentId: agent_id, status })
    return { tasks: tasks.slice(0, limit), total: tasks.length }
  }))

  server.registerTool('get_task', {
    title: 'Get task thread',
    description: "Get a task and its message thread (user prompts, agent replies, intermediate agent messages, permission requests, supervisor reports). Message attachments are listed by id; fetch them with get_message_attachment. Messages with a transcript_key have a full session transcript available via get_message_transcript.",
    inputSchema: {
      task_id: taskId,
      last_messages: z.number().int().min(1).max(500).optional().describe('Only return the most recent N messages.'),
    },
    annotations: READ,
  }, ({ task_id, last_messages }) => run(async () => {
    const [task, { messages }] = await Promise.all([api.getTask(task_id), api.listMessages(task_id)])
    return { task, messages: last_messages ? messages.slice(-last_messages) : messages, message_count: messages.length }
  }))

  server.registerTool('create_task', {
    title: 'Create task',
    description: "Send a new task to an agent (like composing an email). The agent's daemon picks it up on its next poll (≤ 60s) and runs it with its configured CLI. Returns the new task id; follow progress with get_task.",
    inputSchema: {
      team_id: z.string().describe('Project ID.'),
      agent_id: z.string().describe('Agent that will run the task (from list_agents).'),
      subject: z.string().min(1),
      body: z.string().optional().describe('Full instructions for the agent (markdown).'),
      scheduled_at: when,
      auto_close: z.boolean().optional().describe('Close the task automatically when the agent finishes.'),
      save_tokens: saveTokens,
      close_steps: z.array(z.string()).optional().describe('Slash commands the agent runs before the session closes (e.g. /tsq-end-session-memory).'),
      images,
    },
    annotations: WRITE,
  }, (a) => run(() => api.createTask({
    team_id: a.team_id,
    agent_id: a.agent_id,
    subject: a.subject,
    body: a.body,
    scheduled_at: toMillis(a.scheduled_at),
    auto_close: a.auto_close,
    save_tokens: a.save_tokens,
    close_steps: a.close_steps,
  }, decodeImages(a.images))))

  server.registerTool('reply_to_task', {
    title: 'Reply to task',
    description: 'Post a follow-up message in a task thread (answers an agent question, approves/denies a permission request, or gives new instructions). Re-opens the agent session if needed. Can be scheduled.',
    inputSchema: { task_id: taskId, body: z.string().min(1), scheduled_at: when, images },
    annotations: WRITE,
  }, ({ task_id, body, scheduled_at, images: imgs }) => run(() => api.createMessage(task_id, body, toMillis(scheduled_at), decodeImages(imgs))))

  server.registerTool('edit_scheduled_message', {
    title: 'Edit scheduled message',
    description: 'Change the body and/or delivery time of a message that has not been delivered yet.',
    inputSchema: { task_id: taskId, message_id: messageId, body: z.string().optional(), scheduled_at: when },
    annotations: WRITE,
  }, ({ task_id, message_id, body, scheduled_at }) => run(() => api.updateMessage(task_id, message_id, body, toMillis(scheduled_at))))

  server.registerTool('delete_scheduled_message', {
    title: 'Cancel scheduled message',
    description: 'Cancel (delete) a scheduled message that has not been delivered yet.',
    inputSchema: { task_id: taskId, message_id: messageId },
    annotations: DESTRUCTIVE,
  }, ({ task_id, message_id }) => run(async () => { await api.deleteMessage(task_id, message_id); return { ok: true } }))

  server.registerTool('close_task', {
    title: 'Close task',
    description: "Close a task: the agent runs the task's close steps and ends its session.",
    inputSchema: { task_id: taskId },
    annotations: WRITE,
  }, ({ task_id }) => run(() => api.closeTask(task_id)))

  server.registerTool('forward_task', {
    title: 'Forward task',
    description: 'Forward a task (with its thread as context) to another agent, creating a new task. Returns the new task_id.',
    inputSchema: { task_id: taskId, agent_id: z.string().describe('Target agent.'), instructions: z.string().optional() },
    annotations: WRITE,
  }, ({ task_id, agent_id, instructions }) => run(() => api.forwardTask(task_id, agent_id, instructions)))

  server.registerTool('grade_task', {
    title: 'Grade task',
    description: 'Rate the outcome of a task.',
    inputSchema: { task_id: taskId, grade },
    annotations: WRITE,
  }, ({ task_id, grade: g }) => run(() => api.gradeTask(task_id, g)))

  server.registerTool('grade_message', {
    title: 'Grade message',
    description: 'Rate a single agent message.',
    inputSchema: { task_id: taskId, message_id: messageId, grade },
    annotations: WRITE,
  }, ({ task_id, message_id, grade: g }) => run(() => api.gradeMessage(task_id, message_id, g)))

  server.registerTool('update_task_settings', {
    title: 'Update task settings',
    description: 'Change per-task settings (currently token-saving mode).',
    inputSchema: { task_id: taskId, save_tokens: saveTokens },
    annotations: WRITE,
  }, ({ task_id, save_tokens }) => run(() => api.updateTaskSettings(task_id, { save_tokens })))

  server.registerTool('get_message_transcript', {
    title: 'Get session transcript',
    description: 'Fetch the full agent session transcript attached to a message (only messages with transcript_key). Large; use max_chars to keep the tail.',
    inputSchema: { task_id: taskId, message_id: messageId, max_chars: z.number().int().min(1000).max(500000).default(100000) },
    annotations: READ,
  }, ({ task_id, message_id, max_chars }) => run(async () => {
    const text = await api.transcript(task_id, message_id)
    return ok(text.length > max_chars ? `…(truncated, ${text.length} chars total)\n` + text.slice(-max_chars) : text)
  }))

  server.registerTool('get_message_attachment', {
    title: 'Get message attachment',
    description: 'Download an attachment of a message (ids from get_task). Images are returned as image content.',
    inputSchema: { task_id: taskId, message_id: messageId, attachment_id: z.string() },
    annotations: READ,
  }, ({ task_id, message_id, attachment_id }) => run(async () => {
    const { data, mimeType } = await api.attachment(task_id, message_id, attachment_id)
    if (mimeType.startsWith('image/')) return { content: [{ type: 'image' as const, data: toBase64(data), mimeType }] }
    if (mimeType.startsWith('text/') || mimeType === 'application/json') return ok(new TextDecoder().decode(data))
    return {
      content: [{
        type: 'resource' as const,
        resource: { uri: `tasksquad://tasks/${task_id}/messages/${message_id}/attachments/${attachment_id}`, mimeType, blob: toBase64(data) },
      }],
    }
  }))
}

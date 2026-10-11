import { z } from 'zod'
import { READ, WRITE, run, type Register } from './util.js'

const teamId = z.string().describe('Project ID (from list_projects).')
const noteId = z.string().describe('Note ID (from list_notes).')

export const registerNotes: Register = (server, { api }) => {
  server.registerTool('list_notes', {
    title: 'List notes',
    description: 'List project notes (shared markdown docs: specs, ideas, plans). Paginated.',
    inputSchema: {
      team_id: teamId,
      archived: z.boolean().optional().describe('List archived notes instead of active ones.'),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
    annotations: READ,
  }, ({ team_id, ...p }) => run(() => api.listNotes(team_id, p)))

  server.registerTool('get_note', {
    title: 'Get note',
    description: 'Get a note with its full content, comments, and the tasks created from it.',
    inputSchema: { team_id: teamId, note_id: noteId },
    annotations: READ,
  }, ({ team_id, note_id }) => run(async () => {
    const [note, { comments }, { tasks }] = await Promise.all([
      api.getNote(team_id, note_id),
      api.listNoteComments(team_id, note_id),
      api.noteLinkedTasks(team_id, note_id),
    ])
    return { note, comments, linked_tasks: tasks }
  }))

  server.registerTool('create_note', {
    title: 'Create note',
    description: 'Create a markdown note in a project.',
    inputSchema: { team_id: teamId, title: z.string().min(1), content: z.string(), tags: z.array(z.string()).optional() },
    annotations: WRITE,
  }, ({ team_id, ...body }) => run(() => api.createNote(team_id, body)))

  server.registerTool('update_note', {
    title: 'Update note',
    description: 'Update a note title, content and/or tags. content replaces the whole body.',
    inputSchema: { team_id: teamId, note_id: noteId, title: z.string().optional(), content: z.string().optional(), tags: z.array(z.string()).optional() },
    annotations: WRITE,
  }, ({ team_id, note_id, ...body }) => run(() => api.updateNote(team_id, note_id, body)))

  server.registerTool('archive_note', {
    title: 'Archive or restore note',
    description: 'Archive (archived=true) or restore (archived=false) a note.',
    inputSchema: { team_id: teamId, note_id: noteId, archived: z.boolean() },
    annotations: WRITE,
  }, ({ team_id, note_id, archived }) => run(() => api.archiveNote(team_id, note_id, archived)))

  server.registerTool('add_note_comment', {
    title: 'Comment on note',
    description: 'Add a comment to a note.',
    inputSchema: { team_id: teamId, note_id: noteId, content: z.string().min(1) },
    annotations: WRITE,
  }, ({ team_id, note_id, content }) => run(() => api.createNoteComment(team_id, note_id, content)))

  server.registerTool('convert_note_to_task', {
    title: 'Send note to agent',
    description: 'Create a task for an agent from a note (the note becomes the task body). Returns task_id.',
    inputSchema: {
      team_id: teamId,
      note_id: noteId,
      agent_id: z.string(),
      instructions: z.string().optional().describe('Extra instructions prepended to the note.'),
      include_comments: z.boolean().optional(),
      auto_close: z.boolean().optional(),
    },
    annotations: WRITE,
  }, ({ team_id, note_id, ...body }) => run(() => api.convertNote(team_id, note_id, body)))

  server.registerTool('critique_note', {
    title: 'Ask agent to critique note',
    description: 'Ask an agent to review a note. Creates a critique task for that agent and returns its task_id.',
    inputSchema: {
      team_id: teamId,
      note_id: noteId,
      agent_id: z.string(),
      context: z.string().optional().describe('What to focus the critique on.'),
      include_comments: z.boolean().optional(),
    },
    annotations: WRITE,
  }, ({ team_id, note_id, ...body }) => run(() => api.critiqueNote(team_id, note_id, body)))
}

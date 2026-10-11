import { z } from 'zod'
import { READ, WRITE, run, toMillis, type Register } from './util.js'

const teamId = z.string().describe('Project ID (from list_projects).')
const conveyorId = z.string().describe('Conveyor ID (from list_conveyors).')
const schedule = {
  frequency: z.enum(['hourly', 'daily', 'weekly', 'monthly']),
  hour: z.number().int().min(0).max(23).describe('Hour of day in `timezone` (ignored for hourly).'),
  minute: z.number().int().min(0).max(59).optional(),
  day_of_week: z.number().int().min(0).max(6).optional().describe('Weekly only: 0 = Sunday … 6 = Saturday.'),
  day_of_month: z.number().int().min(1).max(31).optional().describe('Monthly only.'),
  repeat_count: z.number().int().min(1).max(1000).optional().describe('Stop after N runs.'),
  end_date: z.string().optional().describe('Stop after this ISO-8601 date-time.'),
  timezone: z.string().optional().describe('IANA timezone, e.g. Europe/Kyiv. Default UTC.'),
  auto_close: z.boolean().optional().describe('Auto-close each generated task when the agent finishes.'),
}

export const registerConveyors: Register = (server, { api }) => {
  server.registerTool('list_conveyors', {
    title: 'List conveyors',
    description: 'List conveyors (recurring scheduled tasks) in a project with their schedule, next_run_at and paused state.',
    inputSchema: { team_id: teamId },
    annotations: READ,
  }, ({ team_id }) => run(() => api.listConveyors(team_id)))

  server.registerTool('create_conveyor', {
    title: 'Create conveyor',
    description: 'Create a recurring task: on each run, a new task with this subject/body is sent to the agent.',
    inputSchema: { team_id: teamId, agent_id: z.string(), subject: z.string().min(1), body: z.string(), ...schedule },
    annotations: WRITE,
  }, ({ team_id, end_date, ...rest }) => run(() => api.createConveyor(team_id, { ...rest, end_date: toMillis(end_date) })))

  server.registerTool('update_conveyor', {
    title: 'Update conveyor',
    description: 'Change any field of a conveyor. Only provided fields change; pass null to clear day_of_week/day_of_month/repeat_count/end_date.',
    inputSchema: {
      team_id: teamId,
      conveyor_id: conveyorId,
      agent_id: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      frequency: schedule.frequency.optional(),
      hour: schedule.hour.optional(),
      minute: schedule.minute,
      day_of_week: schedule.day_of_week.nullable(),
      day_of_month: schedule.day_of_month.nullable(),
      repeat_count: schedule.repeat_count.nullable(),
      end_date: z.string().nullable().optional().describe('ISO-8601, or null to clear.'),
      timezone: schedule.timezone,
      auto_close: schedule.auto_close,
    },
    annotations: WRITE,
  }, ({ team_id, conveyor_id, end_date, ...rest }) => run(() => api.updateConveyor(team_id, conveyor_id, {
    ...rest,
    ...(end_date === undefined ? {} : { end_date: end_date === null ? null : toMillis(end_date) }),
  })))

  server.registerTool('pause_conveyor', {
    title: 'Pause or resume conveyor',
    description: 'Pause (paused=true) or resume (paused=false) a conveyor.',
    inputSchema: { team_id: teamId, conveyor_id: conveyorId, paused: z.boolean() },
    annotations: WRITE,
  }, ({ team_id, conveyor_id, paused }) => run(() => api.updateConveyor(team_id, conveyor_id, { paused })))

  server.registerTool('list_conveyor_tasks', {
    title: 'List conveyor runs',
    description: 'List the tasks a conveyor has generated.',
    inputSchema: { team_id: teamId, conveyor_id: conveyorId },
    annotations: READ,
  }, ({ team_id, conveyor_id }) => run(() => api.conveyorTasks(team_id, conveyor_id)))
}

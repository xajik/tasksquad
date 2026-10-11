import { z } from 'zod'
import { READ, WRITE, run, type Register } from './util.js'

const teamId = z.string().describe('Project ID (from list_projects).')
const plannerId = z.string().describe('Planner ID (from list_planners).')

export const registerPlanners: Register = (server, { api }) => {
  server.registerTool('list_planners', {
    title: 'List planners',
    description: 'List planners: multi-phase pipelines where each phase is a task run by an agent (optionally with a sub-agent), reviewed before the next phase starts.',
    inputSchema: { team_id: teamId },
    annotations: READ,
  }, ({ team_id }) => run(() => api.listPlanners(team_id)))

  server.registerTool('get_planner', {
    title: 'Get planner',
    description: 'Get a planner with all phases: status, task ids, retries, verdicts.',
    inputSchema: { team_id: teamId, planner_id: plannerId },
    annotations: READ,
  }, ({ team_id, planner_id }) => run(() => api.getPlanner(team_id, planner_id)))

  server.registerTool('create_planner', {
    title: 'Create planner',
    description: 'Create and start a planner. The first phase task is created immediately (first_task_id). Each phase needs a harness agent (phase harness_agent_id or default_harness_agent_id).',
    inputSchema: {
      team_id: teamId,
      name: z.string().min(1),
      description: z.string().optional().describe('Overall goal; given to every phase.'),
      max_retries: z.number().int().min(0).max(10).optional(),
      auto_close: z.boolean().optional(),
      default_sub_agent_id: z.string().optional().describe('Sub-agent id (list_library kind=sub-agents).'),
      default_harness_agent_id: z.string().optional().describe('Agent id that runs phases by default.'),
      phases: z.array(z.object({
        name: z.string().min(1),
        sub_agent_id: z.string().optional(),
        harness_agent_id: z.string().optional(),
        max_retries: z.number().int().min(0).max(10).optional(),
        auto_close: z.boolean().optional(),
      })).min(1),
    },
    annotations: WRITE,
  }, ({ team_id, ...body }) => run(() => api.createPlanner(team_id, body)))

  server.registerTool('update_planner', {
    title: 'Pause / review planner',
    description: 'Pause or resume a planner, and/or record the final verdict (1 = approved, 0 = rejected, null = clear).',
    inputSchema: {
      team_id: teamId,
      planner_id: plannerId,
      paused: z.boolean().optional(),
      planner_verdict: z.union([z.literal(0), z.literal(1), z.null()]).optional(),
    },
    annotations: WRITE,
  }, ({ team_id, planner_id, ...body }) => run(() => api.updatePlanner(team_id, planner_id, body)))
}

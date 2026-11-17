import type { Env } from '../types.js'

/** Metadata for the exact inbox attempt. Terminal graph tasks may accept recovery input,
 * but must never be reopened as ordinary daemon work. */
export async function graphInboxTask(
  env: Pick<Env, 'DB' | 'ACTION_GRAPH_ENABLED'>,
  taskId: string,
  userId: string
) {
  if (env.ACTION_GRAPH_ENABLED === undefined) return null
  const row = await env.DB.prepare(
    `SELECT a.id AS assignment_id,a.graph_id,g.team_id,a.node_id,a.edge_id,a.role,a.status,
    t.epoch,(SELECT MAX(epoch) FROM graph_attempts WHERE assignment_id=a.id) AS latest_epoch,m.role AS member_role
    FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id JOIN graphs g ON g.id=a.graph_id
    JOIN tasks task ON task.id=t.task_id AND task.team_id=g.team_id
    JOIN team_members m ON m.team_id=g.team_id AND m.user_id=? WHERE t.task_id=?`
  )
    .bind(userId, taskId)
    .first<{
      assignment_id: string
      graph_id: string
      team_id: string
      node_id: string | null
      edge_id: string | null
      role: string
      status: string
      epoch: number
      latest_epoch: number
      member_role: string
    }>()
  if (!row) return null
  const can_manage = ['owner', 'maintainer'].includes(row.member_role),
    latest = row.epoch === row.latest_epoch
  return {
    assignment_id: row.assignment_id,
    graph_id: row.graph_id,
    team_id: row.team_id,
    node_id: row.node_id,
    edge_id: row.edge_id,
    role: row.role,
    status: row.status,
    latest,
    can_manage,
    can_reply: latest && can_manage && row.role !== 'repair' && ['blocked', 'error'].includes(row.status)
  }
}

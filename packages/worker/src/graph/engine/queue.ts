import { sql } from '../store.js'

export type QueueKind = 'assignment' | 'execution'

/** Marks one serial-queue entry done (idempotent). */
export const queueDone = (db: D1Database, graphId: string, kind: QueueKind, workId: unknown) =>
  sql(db, "UPDATE graph_serial_queue SET status='done' WHERE graph_id=? AND kind=? AND work_id=?", graphId, kind, workId)

/** Appends work to the graph's strictly serial review queue. */
export const queuePush = (db: D1Database, graphId: string, kind: QueueKind, workId: unknown) =>
  sql(db, 'INSERT INTO graph_serial_queue(graph_id,kind,work_id,created_at) VALUES(?,?,?,?)', graphId, kind, workId, Date.now())

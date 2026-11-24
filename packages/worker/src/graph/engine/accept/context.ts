import type { Role } from '../../contracts.js'
import type { Assignment, Data, Graph, Result } from '../../store.js'

/** Everything a role's acceptance step needs; it appends statements to `ops` and may `enqueue` follow-up work. */
export interface AcceptCtx {
  db: D1Database
  g: Graph
  r: Result
  a: Assignment
  original: Assignment
  c: { policy: import('../../contracts.js').Policy; rule: import('../../contracts.js').Rule; version: number }
  d: Data
  input: Data
  ops: D1PreparedStatement[]
  enqueue: (
    role: Role,
    data: unknown,
    links?: { node?: string | null; edge?: string | null; parent?: string | null; priority?: number }
  ) => Promise<string>
}

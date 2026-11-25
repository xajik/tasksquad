import { parse } from 'yaml'
import { rows, type Data, type Graph } from './store.js'

/** One original owner reply per input command. Restart and repair prompts also contain copies;
 * never mine their transcripts or nested prior_user_inputs for decisions. */
interface Reply {
  scope: string
  reply: string
  received: number
}

function fields(text: string): Array<[string, string, string]> {
  if (text.trimStart().startsWith('approval_response:')) {
    try {
      const form = parse(text, { maxAliasCount: 0 })?.approval_response
      if (typeof form?.title === 'string' && form.answers && typeof form.answers === 'object') {
        const answers: Array<[string, string, string]> = []
        for (const [field, value] of Object.entries(form.answers)) {
          if (typeof value === 'string' || (Array.isArray(value) && value.every(v => typeof v === 'string')))
            answers.push([form.title, field, typeof value === 'string' ? value : JSON.stringify(value)])
        }
        if (answers.length) return answers
      }
    } catch { /* Free-form owner replies can also start with the form marker. */ }
  }
  return [['', '', text.trim()]]
}

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map(word => word.replace(/s$/, '')))
}

/** Fold revisions before ranking. Choose whole answers relevant to this task first,
 * then present the selected facts in time order so an older decision cannot look newer. */
export function ownerDecisions(replies: Reply[], budget = 3500, topic = ''): string[] {
  const known = new Set<string>()
  const relevant = words(topic)
  const candidates = replies.flatMap((row, index) => {
    const facts = fields(row.reply).filter(([title, field, value]) => {
      const key = JSON.stringify([row.scope, title, field, field ? '' : value])
      if (!value || known.has(key)) return false
      known.add(key)
      return true
    })
    if (!facts.length) return []
    const title = facts[0][0]
    const terms = words(title ? [title, ...facts.map(([, field]) => field)].join(' ') : row.reply)
    const matches = [...terms].filter(term => relevant.has(term)).length
    const source = new Date(row.received).toISOString().slice(0, 19) + 'Z ' + row.scope
    return [{ index, matches, prefix: source + (title ? ' | ' + title : ''), facts }]
  })
  candidates.sort((a, b) => b.matches - a.matches || a.index - b.index)
  const selected: Array<{ index: number; line: string }> = []
  let omitted = false
  for (const { index, prefix, facts } of candidates) {
    let line = ''
    for (const [, field, value] of facts) {
      const next = (line ? '' : prefix) + ' | ' + (field ? field + ': ' : '') + value
      // A cutoff in a price or approval condition can change its meaning.
      const size = JSON.stringify(next).length + 2
      if (size <= budget) {
        line += next
        budget -= size
      } else omitted = true
    }
    if (line) selected.push({ index, line })
  }
  const lines = selected.sort((a, b) => a.index - b.index).map(item => item.line)
  if (omitted) lines.push('[additional owner answers omitted]')
  return lines
}

export async function graphKnowledge(db: D1Database, g: Graph, planning: boolean, forward: boolean, input: Data) {
  const summary: Record<string, unknown> = {}
  if (planning) {
    const counts = await rows<{ status: string; total: number }>(db,
      'SELECT status,COUNT(*) AS total FROM graphs WHERE team_id=? GROUP BY status ORDER BY status', g.team_id)
    summary.project_graph_counts = Object.fromEntries(counts.map(row => [row.status, row.total]))
    // Backward planners see aggregate progress. Only forward roles see execution-facing action titles.
    const details = await rows<{ id: string; status: string; blocked: number; work: string | null }>(db,
      `SELECT g.id,g.status,
        (SELECT COUNT(*) FROM graph_assignments b WHERE b.graph_id=g.id AND b.status='blocked') AS blocked,
        (SELECT json_object('state',a.status,'action',substr(e.title,1,100),
          'outcome',(SELECT json_extract(r.parsed,'$.outcome') FROM graph_attempts t
          JOIN graph_results r ON r.attempt_id=t.id WHERE t.assignment_id=a.id AND r.status='accepted'
          ORDER BY t.epoch DESC LIMIT 1))
         FROM graph_assignments a JOIN graph_edges e ON e.id=a.edge_id
         WHERE a.graph_id=g.id AND a.role='execute' AND ? ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS work
       FROM graphs g WHERE g.team_id=? ORDER BY (g.id=?) DESC,g.updated_at DESC,g.id LIMIT 40`,
      forward ? 1 : 0, g.team_id, g.id)
    const recent: Data[] = []
    let remaining = 2200
    for (const { id, status, blocked, work } of details) {
      const detail = { id, status, blocked, ...(work ? JSON.parse(work) : {}) }
      const size = JSON.stringify(detail).length + 1
      if (size > remaining) break
      recent.push(detail)
      remaining -= size
    }
    summary.recent_graphs = recent
    const omitted = counts.reduce((total, row) => total + row.total, 0) - recent.length
    if (omitted) summary.additional_graphs_in_counts = omitted
  }
  if (forward) {
    const replies = await rows<Reply>(db,
      `SELECT COALESCE(a.edge_id,json_extract(a.input,'$.assignment')) AS scope,
          json_extract(a.input,'$.user_input') AS reply,MAX(a.created_at) AS received
       FROM graph_assignments a WHERE a.graph_id=? AND a.role='continue'
         AND json_extract(a.input,'$.assignment')=a.parent_id
         AND (json_extract(a.input,'$.original_role') IN ('execute','undo','plan') OR
           (json_extract(a.input,'$.original_role')='merge' AND COALESCE(json_extract(a.input,'$.previous.direction'),'forward')!='backward'))
         AND json_type(a.input,'$.user_input')='text'
       GROUP BY scope,reply ORDER BY received DESC,MAX(a.rowid) DESC`, g.id)
    const subject = input.plan ?? input.task ?? input.action ?? (input.previous as Data | undefined)?.plan ?? {}
    const description = subject as Data
    const topic = typeof subject === 'string' ? subject : [description.title, description.description, description.body].join(' ')
    summary.owner_answers_latest_first = ownerDecisions(replies, 3500, topic)
  }
  return summary
}

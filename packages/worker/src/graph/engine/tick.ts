import { semanticIndex } from '../dedup.js'
import { graph } from '../store.js'
import { dispatch } from './dispatch.js'
import { advanceGrading, parkFailedReviews } from './grading.js'
import { dismissStale, syncInboxStatus } from './owner.js'
import { processResults, revalidateReviews } from './results.js'
import { type GraphEnv } from './shared.js'

export async function tick(env: GraphEnv, graphId: string): Promise<void> {
  const g = await graph(env.DB, graphId)
  await processResults(env.DB, g, semanticIndex(env, g.team_id))
  await revalidateReviews(env.DB, g)
  await dismissStale(env.DB, g)
  await parkFailedReviews(env.DB, g)
  await advanceGrading(env.DB, g)
  await syncInboxStatus(env.DB, g)
  await dispatch(env, g)
}

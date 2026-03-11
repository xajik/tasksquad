import type { Env } from './types.js'

/** Returns the current inbox version string for an agent (used as ETag). */
export async function getInboxVersion(env: Env, agentId: string): Promise<string> {
  return (await env.POLL_CACHE.get(`inbox_v:${agentId}`)) ?? '0'
}

/**
 * Bumps the inbox version for an agent in KV.
 * Call this whenever a new pending task or user reply is written for the agent
 * so the next heartbeat ETag check detects the change.
 */
export async function bumpInboxVersion(env: Env, agentId: string): Promise<void> {
  await env.POLL_CACHE.put(`inbox_v:${agentId}`, Date.now().toString())
}

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

/**
 * Returns a combined ETag for a set of agents: SHA-256 of "agentId1:v1;agentId2:v2"
 * in the order provided. Fetches all individual versions in parallel.
 */
export async function getCombinedInboxVersion(env: Env, agentIds: string[]): Promise<string> {
  const versions = await Promise.all(agentIds.map(id => getInboxVersion(env, id)))
  const combined = agentIds.map((id, i) => `${id}:${versions[i]}`).join(';')
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(combined))
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

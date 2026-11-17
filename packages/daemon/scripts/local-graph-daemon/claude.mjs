#!/usr/bin/env node
// stdout provider adapter: the daemon owns process/session lifecycle.
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const prompt = process.argv[process.argv.indexOf('-p') + 1]
if (!prompt || !process.argv.includes('-p')) throw new Error('Missing daemon prompt')
const now = Date.now()
const clock = `local-clock-${process.env.TSQ_TASK_ID}.json`
writeFileSync(clock, JSON.stringify({now_ms: now, expires_at_ms: now + 3600000}))
const tools = process.argv.includes('--read-only') ? 'Read,Glob,Grep' : 'Read,Write,Edit,Glob,Grep'
const result = spawnSync('claude', [
  '--print', '--output-format', 'text', '--no-session-persistence',
  '--restricted', '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--tools', tools, '--allowedTools', tools, '--permission-mode', 'acceptEdits',
  '--permission-prompts', 'none',
  `${prompt}\n\nLocal runtime: work only inside ${process.cwd()}.${prompt.includes("matching this closed schema") ? ` Read ${clock} for now_ms and expires_at_ms when reporting evidence timestamps. This clock is runtime metadata unique to this invocation, not a separate goal or action. Earlier role results legitimately cite their own invocation clocks, which differ from yours. Return only the required JSON. For resource_versions, copy exact resource IDs from context; do not append @version or other suffixes. from_id must be an active observed state ID, never an unexecuted milestone or goal.` : ""}`
], { stdio: 'inherit', env: {...process.env, CLAUDE_CODE_SAFE_MODE: '1'} })
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)

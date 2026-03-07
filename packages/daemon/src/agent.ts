import { join } from 'path'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { apiPost } from './api.ts'
import type { Config, AgentConfig } from './config.ts'

interface Task {
  id: string
  subject: string
  body: string
}

type Mode = 'idle' | 'running' | 'waiting_input'

export class Agent {
  readonly config: AgentConfig
  mode: Mode = 'idle'
  taskId: string | null = null
  sessionId: string | null = null

  private outputLines: string[] = []
  private isCompleting = false
  private proc: ReturnType<typeof Bun.spawn> | null = null

  constructor(agentConfig: AgentConfig) {
    this.config = agentConfig
  }

  async heartbeat(cfg: Config): Promise<void> {
    try {
      const res = await apiPost<{ ok: boolean; task?: Task }>(cfg, '/daemon/heartbeat', {
        agent_id: this.config.id,
        status: this.mode,
      })

      if (res.task && this.mode === 'idle') {
        await this.startTask(cfg, res.task)
      }
    } catch (err) {
      console.error(`[${this.config.name}] heartbeat error:`, err)
    }
  }

  private async startTask(cfg: Config, task: Task): Promise<void> {
    console.log(`[${this.config.name}] Starting task ${task.id}: ${task.subject}`)
    this.mode = 'running'
    this.taskId = task.id
    this.outputLines = []
    this.isCompleting = false

    // Open session on the server
    let sessionId: string
    try {
      const res = await apiPost<{ session_id: string }>(cfg, '/daemon/session/open', {
        task_id: task.id,
        agent_id: this.config.id,
      })
      sessionId = res.session_id
      this.sessionId = sessionId
    } catch (err) {
      console.error(`[${this.config.name}] session-open failed:`, err)
      this.mode = 'idle'
      return
    }

    // Write Claude Code hooks into the project's .claude/settings.json
    this.writeHooks(cfg)

    // Build prompt
    const prompt = task.body && task.body !== task.subject
      ? `${task.subject}\n\n${task.body}`
      : task.subject

    // Spawn claude
    const [cmd, ...args] = this.config.command.split(' ')
    const proc = Bun.spawn([cmd, ...args, '-p', prompt], {
      cwd: this.config.workDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    })
    this.proc = proc

    // Stream stdout to server
    this.streamOutput(cfg, proc).catch(err =>
      console.error(`[${this.config.name}] stream error:`, err)
    )

    // On process exit → complete
    proc.exited.then(code => {
      this.complete(cfg, code === 0 ? 'closed' : 'crashed').catch(err =>
        console.error(`[${this.config.name}] complete error:`, err)
      )
    })
  }

  private async streamOutput(cfg: Config, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const reader = proc.stdout.getReader()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += new TextDecoder().decode(value)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      if (lines.length > 0) {
        this.outputLines.push(...lines)
        // Push lines to SSE in the background — don't block streaming
        apiPost(cfg, `/daemon/push/${this.config.id}`, {
          type: 'line',
          lines,
        }).catch(() => { /* ignore push failures */ })
      }
    }

    // Flush any remaining buffer
    if (buffer) {
      this.outputLines.push(buffer)
      apiPost(cfg, `/daemon/push/${this.config.id}`, {
        type: 'line',
        lines: [buffer],
      }).catch(() => {})
    }
  }

  async complete(cfg: Config, status: 'closed' | 'crashed' | 'waiting_input' = 'closed'): Promise<void> {
    if (this.isCompleting || !this.sessionId) return
    this.isCompleting = true

    console.log(`[${this.config.name}] Completing task ${this.taskId} with status=${status}`)

    // Last ~2000 chars of output as final_text
    const fullOutput = this.outputLines.join('\n')
    const finalText = fullOutput.slice(-2000).trim()

    try {
      await apiPost(cfg, '/daemon/session/close', {
        session_id: this.sessionId,
        agent_id: this.config.id,
        status,
        final_text: finalText || undefined,
      })
    } catch (err) {
      console.error(`[${this.config.name}] session-close error:`, err)
    }

    // Signal SSE viewers that the session ended
    const sseType = status === 'waiting_input' ? 'waiting_input' : 'done'
    apiPost(cfg, `/daemon/push/${this.config.id}`, {
      type: sseType,
      lines: [finalText || ''],
    }).catch(() => {})

    this.mode = status === 'waiting_input' ? 'waiting_input' : 'idle'
    this.sessionId = null
    this.outputLines = []
    this.proc = null
    this.isCompleting = false
  }

  async setWaitingInput(cfg: Config, message: string): Promise<void> {
    if (this.mode !== 'running') return
    // Push the notification message as a line first
    await apiPost(cfg, `/daemon/push/${this.config.id}`, {
      type: 'line',
      lines: [`\n[Claude is waiting for your input]\n${message}`],
    }).catch(() => {})
    await this.complete(cfg, 'waiting_input')
  }

  private writeHooks(cfg: Config): void {
    const port = cfg.hooksPort
    const claudeDir = join(this.config.workDir, '.claude')
    const settingsPath = join(claudeDir, 'settings.json')

    try {
      mkdirSync(claudeDir, { recursive: true })

      let existing: Record<string, unknown> = {}
      if (existsSync(settingsPath)) {
        try { existing = JSON.parse(readFileSync(settingsPath, 'utf8')) } catch { /* ignore */ }
      }

      const hooks = {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: `curl -s -X POST http://localhost:${port}/hooks/stop -H 'Content-Type: application/json' -d @-` }] }],
        Notification: [{ matcher: '', hooks: [{ type: 'command', command: `curl -s -X POST http://localhost:${port}/hooks/notification -H 'Content-Type: application/json' -d @-` }] }],
      }

      writeFileSync(settingsPath, JSON.stringify({ ...existing, hooks }, null, 2))
    } catch (err) {
      console.warn(`[${this.config.name}] Could not write .claude/settings.json:`, err)
    }
  }
}

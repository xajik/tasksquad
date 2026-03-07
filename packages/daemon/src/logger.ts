import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, appendFileSync } from 'fs'

const logDir = join(homedir(), '.tasksquad', 'logs')
mkdirSync(logDir, { recursive: true })

function logFile(): string {
  const d = new Date()
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return join(logDir, `daemon-${date}.log`)
}

function ts(): string {
  return new Date().toISOString()
}

function write(level: string, msg: string) {
  const line = `${ts()} [${level}] ${msg}\n`
  process.stdout.write(line)
  try { appendFileSync(logFile(), line) } catch { /* ignore fs errors */ }
}

export const log = {
  info:  (msg: string) => write('INFO ', msg),
  debug: (msg: string) => write('DEBUG', msg),
  warn:  (msg: string) => write('WARN ', msg),
  error: (msg: string) => write('ERROR', msg),
}

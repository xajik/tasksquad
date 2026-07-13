import type { D1Database } from '@cloudflare/workers-types'
import { ulid } from 'ulidx'
import type { Env } from '../types.js'
import { importMasterKey, unwrapDEK, encrypt, decrypt } from '../crypto.js'

export async function requireMember(db: D1Database, teamId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, userId)
    .first<{ role: string }>()
  return !!row
}

export async function contentEtag(content: string): Promise<string> {
  const enc = new TextEncoder()
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(content))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ─── Message attachments (images) ─────────────────────────────────────────────
//
// One message_attachments row per image, regardless of who attached it
// (supervisor screenshot, agent via `tsq attach`, or a user upload from the
// portal). Portal uploads reach the Worker as plaintext bytes already in
// memory (multipart body), so encryption happens server-side here; the
// daemon's own presign+PUT path (supervisor screenshots, `tsq attach`)
// encrypts client-side before it ever reaches the Worker and writes rows via
// a separate insert in routes/daemon.ts's messageAttach.

export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024
export const ATTACHMENT_MAX_PER_MESSAGE = 3
export const ATTACHMENT_MIME_ALLOWLIST = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export interface StoredAttachment {
  id: string
  filename: string
  mime_type: string
  size: number
}

export async function storeMessageAttachment(
  env: Env,
  agentId: string,
  messageId: string,
  filename: string,
  mimeType: string,
  bytes: Uint8Array
): Promise<StoredAttachment | { error: string }> {
  if (!ATTACHMENT_MIME_ALLOWLIST.has(mimeType)) return { error: 'unsupported_mime_type' }
  if (bytes.byteLength > ATTACHMENT_MAX_BYTES) return { error: 'file_too_large' }

  const count = await env.DB
    .prepare('SELECT COUNT(*) as n FROM message_attachments WHERE message_id = ?')
    .bind(messageId)
    .first<{ n: number }>()
  if ((count?.n ?? 0) >= ATTACHMENT_MAX_PER_MESSAGE) return { error: 'too_many_attachments' }

  const id = ulid()
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'image'
  const r2Key = `${agentId.substring(0, 16)}/inbox/${messageId}/${id}-${sanitized}`

  let toStore = bytes
  const agent = await env.DB
    .prepare('SELECT encrypted_dek FROM agents WHERE id = ?')
    .bind(agentId)
    .first<{ encrypted_dek: string | null }>()
  if (agent?.encrypted_dek && env.R2_LOGS_MASTER_KEY) {
    try {
      const masterKey = await importMasterKey(env.R2_LOGS_MASTER_KEY)
      const dek = await unwrapDEK(agent.encrypted_dek, masterKey)
      toStore = await encrypt(bytes, dek)
    } catch (e) {
      console.error(`[attachments] encryption failed, storing plaintext: ${e}`)
    }
  }

  await env.LOGS.put(r2Key, toStore)

  const now = Date.now()
  await env.DB
    .prepare('INSERT INTO message_attachments (id, message_id, r2_key, mime_type, filename, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, messageId, r2Key, mimeType, sanitized, bytes.byteLength, now)
    .run()

  return { id, filename: sanitized, mime_type: mimeType, size: bytes.byteLength }
}

export async function readMessageAttachment(
  env: Env,
  attachmentId: string,
  messageId: string,
  agentId: string
): Promise<{ bytes: Uint8Array; mimeType: string; filename: string } | null> {
  const row = await env.DB
    .prepare('SELECT r2_key, mime_type, filename FROM message_attachments WHERE id = ? AND message_id = ?')
    .bind(attachmentId, messageId)
    .first<{ r2_key: string; mime_type: string; filename: string }>()
  if (!row) return null

  const obj = await env.LOGS.get(row.r2_key)
  if (!obj) return null

  const encrypted = new Uint8Array(await obj.arrayBuffer())
  let plaintext = encrypted

  const agent = await env.DB
    .prepare('SELECT encrypted_dek FROM agents WHERE id = ?')
    .bind(agentId)
    .first<{ encrypted_dek: string | null }>()
  if (agent?.encrypted_dek && env.R2_LOGS_MASTER_KEY) {
    try {
      const masterKey = await importMasterKey(env.R2_LOGS_MASTER_KEY)
      const dek = await unwrapDEK(agent.encrypted_dek, masterKey)
      plaintext = await decrypt(encrypted, dek)
    } catch (e) {
      console.error(`[attachments] decryption failed: ${e}`)
    }
  }

  return { bytes: plaintext, mimeType: row.mime_type, filename: row.filename }
}

export async function storeAttachments(
  env: Env,
  agentId: string,
  messageId: string,
  files: File[]
): Promise<StoredAttachment[]> {
  const out: StoredAttachment[] = []
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const result = await storeMessageAttachment(env, agentId, messageId, file.name, file.type, bytes)
    if ('error' in result) {
      console.error(`[attachments] failed to store ${file.name}: ${result.error}`)
      continue
    }
    out.push(result)
  }
  return out
}

export async function fetchAttachmentsForMessages(
  env: Env,
  messageIds: string[]
): Promise<Map<string, { id: string; filename: string; mime_type: string; size: number }[]>> {
  const map = new Map<string, { id: string; filename: string; mime_type: string; size: number }[]>()
  if (messageIds.length === 0) return map

  const placeholders = messageIds.map(() => '?').join(',')
  const rows = await env.DB
    .prepare(`SELECT id, message_id, filename, mime_type, size FROM message_attachments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`)
    .bind(...messageIds)
    .all<{ id: string; message_id: string; filename: string; mime_type: string; size: number }>()

  for (const row of rows.results) {
    const arr = map.get(row.message_id) ?? []
    arr.push({ id: row.id, filename: row.filename, mime_type: row.mime_type, size: row.size })
    map.set(row.message_id, arr)
  }
  return map
}

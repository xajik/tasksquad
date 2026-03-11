# TaskSquad Security Review

**Repository:** Public  
**Date:** 2026-03-10  
**Reviewer:** Security Audit  
**Status:** Issues Found - Do Not Deploy to Production

---

## Executive Summary

This document outlines security vulnerabilities discovered in the TaskSquad codebase. **None of these issues should be present in a production system, especially one with a public repository.** Several vulnerabilities allow unauthorized access to other users' data, which is a critical violation of privacy and security principles.

**URGENT: Do not release to production until all Critical and High severity issues are resolved.**

---

## Vulnerability Index

| # | Severity | Type | Status |
|---|----------|------|--------|
| 1 | CRITICAL | IDOR - Cross-Agent Access | Not Fixed |
| 2 | CRITICAL | IDOR - Data Access via Token Theft | Not Fixed |
| 3 | HIGH | PII Exposure - Email Leakage | Not Fixed |
| 4 | HIGH | PII Exposure - Team Member Enumeration | Not Fixed |
| 5 | MEDIUM | CORS Misconfiguration | Not Fixed |
| 6 | MEDIUM | Token in Query String | Not Fixed |
| 7 | MEDIUM | Insufficient Authorization | Not Fixed |
| 8 | MEDIUM | Timing Attack on Admin Secret | Not Fixed |
| 9 | MEDIUM | Hook Server Network Exposure | Not Fixed |
| 10 | LOW | Unused Data Exposure | Not Fixed |
| 11 | LOW | No Rate Limiting | Not Fixed |
| 12 | LOW | Daemon Token No Expiration | Not Fixed |

---

## CRITICAL SEVERITY

### 1. IDOR - Daemon Can Access Any Agent's Stream in Team

**File:** `packages/worker/src/routes/daemon.ts`  
**Lines:** 263-290

**Problem:**
```typescript
// PROBLEMATIC CODE
export async function viewers(req: Request, env: Env, _ctx: unknown, _daemon: DaemonContext): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.pathname.split('/')[3]  // From URL, NOT from _daemon!

  const doId = env.AGENT_RELAY.idFromName(agentId)
  const stub = env.AGENT_RELAY.get(doId)
  return stub.fetch(new Request('https://relay/viewers'))
}

export async function push(req: Request, env: Env, _ctx: unknown, _daemon: DaemonContext): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.pathname.split('/')[3]  // From URL, NOT from _daemon!
```

The `_daemon` parameter (which contains the authenticated agent's context) is completely ignored. The agentId is taken directly from the URL path.

**Impact:**
- Any daemon authenticated with a token for Agent A can push output to ANY agent in the team
- Any daemon can query viewer counts for ANY agent in the team
- A compromised daemon token enables lateral movement within the team

**Why This Must Be Fixed Before Production:**
In a public repository, attackers can obtain the code, study the API, and craft requests. Even without direct token theft, if any daemon token is compromised (e.g., through log exposure, misconfigured deployment, or insider threat), the attacker can:
1. Monitor all agent activity in the team
2. Inject fake output into other agents' streams
3. Disrupt task execution across the entire team

**Remediation:**
```typescript
// FIXED CODE
export async function viewers(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  // Use authenticated agentId from daemon context, NOT from URL
  const agentId = daemon.agentId

  const doId = env.AGENT_RELAY.idFromName(agentId)
  const stub = env.AGENT_RELAY.get(doId)
  return stub.fetch(new Request('https://relay/viewers'))
}

export async function push(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  // Use authenticated agentId from daemon context, NOT from URL
  const agentId = daemon.agentId

  const body = await req.json<{ type?: string; lines?: string[] }>()
  if (!body.type || !body.lines) return err('missing_fields', 400)

  const doId = env.AGENT_RELAY.idFromName(agentId)
  const stub = env.AGENT_RELAY.get(doId)
  await stub.fetch(new Request('https://relay/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

  return json({ ok: true })
}
```

---

### 2. IDOR - Daemon Can Access Tasks/Sessions of Other Agents

**File:** `packages/worker/src/routes/daemon.ts`  
**Lines:** 321-331, 402-412

**Problem:**
```typescript
// presignUpload - only validates agent_id matches, not team ownership
const session = await env.DB
  .prepare('SELECT id FROM sessions WHERE id = ? AND agent_id = ?')
  .bind(session_id, agentId)

// sessionAttach - same issue
const session = await env.DB
  .prepare('SELECT id FROM sessions WHERE id = ? AND agent_id = ?')
  .bind(sessionId, agentId)
```

While these queries do validate `agent_id`, they don't verify that the session actually belongs to the agent's team context. The daemon's `teamId` is not used in authorization checks for these endpoints.

**Impact:**
- A daemon could potentially manipulate sessions from other agents in the same team
- Uploaded files could be associated with wrong sessions

**Why This Must Be Fixed Before Production:**
An attacker with a valid daemon token could potentially:
1. Attach files to sessions they don't own
2. Get presigned URLs for other agents' session data

**Remediation:**
```typescript
// FIXED CODE - Add team validation
export async function presignUpload(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const body = await req.json<{ session_id: string; filename: string }>()
  const { session_id, filename } = body
  const agentId = daemon.agentId
  const teamId = daemon.teamId
  if (!session_id || !filename) return err('missing_fields', 400)

  // Validate session belongs to an agent in the daemon's team
  const session = await env.DB
    .prepare(`SELECT s.id FROM sessions s 
              JOIN agents a ON s.agent_id = a.id 
              WHERE s.id = ? AND a.id = ? AND a.team_id = ?`)
    .bind(session_id, agentId, teamId)
    .first<{ id: string }>()
  if (!session) return err('not_found', 404)
  // ... rest of function
}
```

---

## HIGH SEVERITY

### 3. PII Exposure - User Emails Leaked in Task Forwarding

**File:** `packages/worker/src/routes/tasks.ts`  
**Lines:** 190-202

**Problem:**
```typescript
const { results: msgs } = await env.DB
  .prepare(`
    SELECT m.role, m.body, u.email
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.task_id = ? ORDER BY m.created_at ASC
  `)
  .bind(taskId)
  .all<{ role: string; body: string; email: string | null }>()

const history = msgs.map(m => {
  const label = m.role === 'user' ? (m.email ?? 'User') : 'Agent'
  return `[${label}]: ${m.body}`
}).join('\n\n---\n\n')
```

When a task is forwarded to another agent, the full email addresses of ALL previous message senders are included in the forwarded thread.

**Impact:**
- Recipient agent (and anyone with access to that task's messages) can see email addresses of all previous participants
- Email addresses are stored in message history permanently

**Why This Must Be Fixed Before Production:**
This is a **privacy violation** (GDPR, CCPA compliance issue):
1. Users' email addresses are shared without explicit consent
2. Forwarded threads become a data spill vector
3. In enterprise settings, this could expose internal email addresses to external agents or third-party AI providers

**Remediation:**
```typescript
// FIXED CODE - Remove email from query
const { results: msgs } = await env.DB
  .prepare(`
    SELECT m.role, m.body
    FROM messages m
    WHERE m.task_id = ? ORDER BY m.created_at ASC
  `)
  .bind(taskId)
  .all<{ role: string; body: string }>()

// Use generic labels instead of email
const history = msgs.map(m => {
  const label = m.role === 'user' ? 'User' : 'Agent'
  return `[${label}]: ${m.body}`
}).join('\n\n---\n\n')
```

---

### 4. PII Exposure - Team Member Email Enumeration

**File:** `packages/worker/src/routes/teams.ts`  
**Lines:** 112-122

**Problem:**
```typescript
const rows = await env.DB
  .prepare(`
    SELECT u.id, u.email, tm.role, tm.joined_at
    FROM team_members tm JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = ?
    ORDER BY tm.joined_at ASC
  `)
  .all<{ id: string; email: string; role: string; joined_at: number }>()

return json({ members: rows.results })
```

Any team member can retrieve the email addresses of ALL other team members.

**Impact:**
- Enables email enumeration attacks
- Social engineering: attackers know exactly who is in the team
- competitor intelligence: reveals team size and member identities

**Why This Must Be Fixed Before Production:**
This is a **critical privacy issue** in a public repository:
1. Any user can enumerate all team member emails
2. This enables targeted phishing attacks
3. Violates principle of data minimization
4. In B2B contexts, reveals internal organizational structure

**Remediation:**
```typescript
// Option 1: Only expose emails to team owners/maintainers
export async function listMembers(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]

  // Check caller's role
  const caller = await env.DB
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, auth.userId)
    .first<{ role: string }>()
  if (!caller) return err('not_found', 404)

  // Only owners/maintainers can see emails
  const canViewEmail = caller.role === 'owner' || caller.role === 'maintainer'

  let rows
  if (canViewEmail) {
    rows = await env.DB
      .prepare(`
        SELECT u.id, u.email, tm.role, tm.joined_at
        FROM team_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ?
        ORDER BY tm.joined_at ASC
      `)
      .bind(teamId)
      .all<{ id: string; email: string; role: string; joined_at: number }>()
  } else {
    // Regular members only see anonymized data
    rows = await env.DB
      .prepare(`
        SELECT tm.role, tm.joined_at
        FROM team_members tm
        WHERE tm.team_id = ?
        ORDER BY tm.joined_at ASC
      `)
      .bind(teamId)
      .all<{ role: string; joined_at: number }>()
  }

  return json({ members: rows.results })
}

// Option 2: Remove email entirely from API (recommended for public repo)
```

---

## MEDIUM SEVERITY

### 5. CORS Allows All Origins

**File:** `packages/worker/src/index.ts`  
**Lines:** 18-22

**Problem:**
```typescript
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',  // Allows any website!
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-TSQ-Token',
}
```

**Impact:**
- Any website can make authenticated requests on behalf of users
- Enables CSRF attacks (though mitigated by requiring Authorization header)
- In combination with other issues, increases attack surface

**Why This Must Be Fixed Before Production:**
In a public repository, the API endpoint is discoverable. While Cloudflare provides some protection, permissive CORS:
1. Violates security best practices
2. May cause issues with browser security features
3. Makes debugging harder (can't distinguish legitimate from attack traffic)

**Remediation:**
```typescript
// Option 1: Restrict to known origins
const ALLOWED_ORIGINShttps://tasksquad = ['.ai', 'http://localhost:5173']

function addCors(res: Response, req: Request): Response {
  const origin = req.headers.get('Origin') || ''
  const headers = new Headers(res.headers)
  
  // Only allow specific origins
  if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.some(o => origin.endsWith(o))) {
    headers.set('Access-Control-Allow-Origin', origin)
  } else {
    headers.set('Access-Control-Allow-Origin', 'null')
  }
  
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-TSQ-Token')
  
  return new Response(res.body, { status: res.status, headers })
}

// Option 2: Use environment-based configuration
const CORS_ORIGINS = (env.ALLOWED_ORIGINS || '').split(',').filter(Boolean)

function addCors(res: Response, req: Request): Response {
  const origin = req.headers.get('Origin') || ''
  const headers = new Headers(res.headers)
  
  if (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin)
  }
  
  return new Response(res.body, { status: res.status, headers })
}
```

---

### 6. Token in Query String

**File:** `packages/worker/src/routes/live.ts`  
**Lines:** 11-14

**Problem:**
```typescript
const rawToken =
  req.headers.get('Authorization')?.slice(7) ??
  url.searchParams.get('token') ??  // Token in URL!
  ''
```

The `/live/:agentId` endpoint accepts Firebase tokens in the URL query parameter.

**Impact:**
- Token appears in server logs
- Token appears in browser history
- Token appears in referrer headers
- Token may be cached by proxies

**Why This Must Be Fixed Before Production:**
Query string tokens are a well-known security anti-pattern:
1. Logs often include full URLs with tokens
2. Browser extensions can read all page URLs
3. Referrer headers leak to third-party analytics
4. Proxy servers may cache URLs

**Remediation:**
```typescript
// FIXED CODE - Remove query string token support
export async function connect(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.pathname.split('/')[2]

  // Only accept Authorization header
  const rawToken = req.headers.get('Authorization')?.slice(7)
  if (!rawToken) return err('unauthorized', 401)

  const auth = await verifyTokenString(rawToken, env)
  if (!auth) return err('invalid_token', 401)

  // ... rest of function
}
```

---

### 7. messageAttach Missing Team Validation

**File:** `packages/worker/src/routes/daemon.ts`  
**Lines:** 382-400

**Problem:**
```typescript
// Verify message belongs to a task in the agent's team
const msg = await env.DB
  .prepare('SELECT m.id FROM messages m JOIN tasks t ON m.task_id = t.id WHERE m.id = ? AND t.team_id = ?')
  .bind(msgId, daemon.teamId)  // Only checks team_id, not agent_id!
```

This validates the team but doesn't verify the daemon's agent actually owns the task.

**Impact:**
- A daemon could attach files to messages from other agents in the same team

**Remediation:**
```typescript
// FIXED CODE
export async function messageAttach(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const url = new URL(req.url)
  const msgId = url.pathname.split('/')[3]
  const body = await req.json<{ transcript_key?: string }>()
  if (!body.transcript_key) return err('missing_key', 400)

  // Verify message belongs to a task owned by THIS agent in the team
  const msg = await env.DB
    .prepare(`SELECT m.id FROM messages m 
              JOIN tasks t ON m.task_id = t.id 
              WHERE m.id = ? AND t.team_id = ? AND t.agent_id = ?`)
    .bind(msgId, daemon.teamId, daemon.agentId)
    .first()
  if (!msg) return err('not_found', 404)

  await env.DB.prepare('UPDATE messages SET transcript_key = ? WHERE id = ?')
    .bind(body.transcript_key, msgId)
    .run()

  return json({ ok: true })
}
```

---

### 8. Timing Attack on Admin Secret

**File:** `packages/worker/src/routes/me.ts`  
**Lines:** 24-26

**Problem:**
```typescript
const secret = req.headers.get('X-Admin-Secret')
if (!env.ADMIN_SECRET || !secret || secret !== env.ADMIN_SECRET) {
  return err('forbidden', 403)
}
```

Simple string comparison (`!==`) is vulnerable to timing attacks.

**Impact:**
- Attacker can brute-force admin secret by measuring response times
- Enables privilege escalation to modify user plans

**Why This Must Be Fixed Before Production:**
While the attack is computationally expensive, it's feasible:
1. Timing differences are measurable
2. Admin endpoints modify critical user data (plan levels)
3. In a public repo, attackers know exactly what endpoint to target

**Remediation:**
```typescript
// FIXED CODE
import { err } from '../auth.js'

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Pad shorter string to prevent length-based timing leak
    const bufA = new Uint8Array(Math.max(a.length, b.length))
    const bufB = new Uint8Array(Math.max(a.length, b.length))
    bufA.set(new TextEncoder().encode(a))
    bufB.set(new TextEncoder().encode(b))
    // Deliberately perform comparison that takes same time regardless of match
    for (let i = 0; i < bufA.length; i++) {
      if (bufA[i] !== bufB[i]) return false
    }
    return false
  }
  
  const encA = new TextEncoder().encode(a)
  const encB = new TextEncoder().encode(b)
  return crypto.subtle.timingSafeEqual(encA, encB)
}

export async function setUserPlan(req: Request, env: Env): Promise<Response> {
  const secret = req.headers.get('X-Admin-Secret')
  if (!env.ADMIN_SECRET || !secret || !timingSafeEqual(secret, env.ADMIN_SECRET)) {
    return err('forbidden', 403)
  }
  // ... rest of function
}
```

---

### 9. Hook Server Binds to All Interfaces

**File:** `packages/daemon/hooks/server.go`  
**Lines:** 245-247

**Problem:**
```go
addr := fmt.Sprintf(":%d", cfg.Hooks.Port)
logger.Info(fmt.Sprintf("[hooks] Server listening on http://localhost%s", addr))
go http.ListenAndServe(addr, mux)
```

The hook server binds to `:*` (all interfaces) rather than `127.0.0.1`.

**Impact:**
- Any local process could POST to hook endpoints
- If machine is compromised, attacker can control agent behavior

**Why This Must Be Fixed Before Production:**
While this is primarily a defense-in-depth issue:
1. Local privilege escalation could allow hook injection
2. Confusing configuration - code says "localhost" but actually binds to all

**Remediation:**
```go
// FIXED CODE
addr := fmt.Sprintf("127.0.0.1:%d", cfg.Hooks.Port)
logger.Info(fmt.Sprintf("[hooks] Server listening on http://%s", addr))
go http.ListenAndServe(addr, mux)
```

---

## LOW SEVERITY

### 10. Unused sender_id Exposure in Messages API

**File:** `packages/worker/src/routes/messages.ts`  
**Line:** 26

**Problem:**
```typescript
const rows = await env.DB
  .prepare('SELECT id, task_id, sender_id, role, body, transcript_key, created_at FROM messages WHERE task_id = ? ORDER BY created_at ASC')
```

The `sender_id` field is returned but not used by clients.

**Impact:**
- Enables user enumeration within a team
- Information disclosure (low impact)

**Remediation:**
```typescript
// Remove sender_id from SELECT if not needed
const rows = await env.DB
  .prepare('SELECT id, task_id, role, body, transcript_key, created_at FROM messages WHERE task_id = ? ORDER BY created_at ASC')
  .bind(taskId)
  .all()
```

---

### 11. No Rate Limiting

**Impact:**
- Brute-force attacks on authentication
- DoS via request flooding
- Token enumeration

**Remediation:**
Implement rate limiting at Cloudflare edge or in the Worker using a KV store to track request counts per IP/user.

---

### 12. Daemon Tokens Have No Expiration

**File:** `packages/worker/src/routes/agents.ts`  
**Lines:** 101-114

**Problem:**
Daemon tokens created have no expiration date - valid indefinitely.

**Impact:**
- Compromised tokens remain valid forever
- No way to rotate tokens automatically

**Remediation:**
```typescript
// Add expires_at column to daemon_tokens table
// In createToken:
const expiresAt = Date.now() + (90 * 24 * 60 * 60 * 1000) // 90 days

await env.DB
  .prepare('INSERT INTO daemon_tokens (id, team_id, agent_id, token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .bind(id, teamId, agentId ?? null, hash, label, now, expiresAt)
  .run()

// In withDaemonAuth, check expiration:
const row = await env.DB
  .prepare('SELECT id, team_id, agent_id, expires_at FROM daemon_tokens WHERE token_hash = ?')
  .bind(hash)
  .first<{ id: string; team_id: string; agent_id: string; expires_at: number }>()

if (!row || (row.expires_at && row.expires_at < Date.now())) {
  return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
}
```

---

## Additional Security Recommendations

### Before Production Release

1. **Secret Rotation**: Implement automated secret rotation for R2 keys, Firebase credentials
2. **Audit Logging**: Add comprehensive audit logs for all data access
3. **Input Validation**: Validate and sanitize all user inputs
4. **Path Traversal**: Validate `work_dir` doesn't contain `..`
5. **HTTPS Enforcement**: Ensure all production traffic uses HTTPS
6. **Security Headers**: Add CSP, X-Frame-Options, X-Content-Type-Options
7. **Penetration Testing**: Conduct external security audit before launch

### Database Schema Additions

```sql
-- Add expiration to daemon_tokens
ALTER TABLE daemon_tokens ADD COLUMN expires_at INTEGER;

-- Consider for future:
-- ALTER TABLE daemon_tokens ADD COLUMN last_used_ip TEXT;
-- ALTER TABLE daemon_tokens ADD COLUMN created_ip TEXT;
```

---

## Conclusion

This codebase has **multiple critical security vulnerabilities** that must be addressed before production deployment:

1. **IDOR vulnerabilities** allow unauthorized data access - a fundamental security failure
2. **PII exposure** violates user privacy and potentially GDPR/CCPA
3. **Authentication weaknesses** enable token-based attacks

**Do not deploy to production until all CRITICAL and HIGH severity issues are resolved.**

---

*Document Version: 1.0*  
*Next Review: After fixes are implemented*

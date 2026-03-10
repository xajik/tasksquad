export interface Env {
  DB: D1Database
  LOGS: R2Bucket
  JWKS_CACHE: KVNamespace
  AGENT_RELAY: DurableObjectNamespace
  FIREBASE_PROJECT_ID: string
  FIREBASE_SERVICE_ACCOUNT_KEY: string
  DAEMON_SECRET: string
  // R2 S3-compatible credentials for generating presigned PUT URLs.
  // Set via: wrangler secret put R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  // Set via: wrangler secret put CLOUDFLARE_ACCOUNT_ID / R2_BUCKET_NAME
  CLOUDFLARE_ACCOUNT_ID: string
  R2_BUCKET_NAME: string
  // Master key for wrapping agent DEKs (256-bit base64)
  R2_LOGS_MASTER_KEY: string
  // Optional secret for admin endpoints (set via: wrangler secret put ADMIN_SECRET)
  ADMIN_SECRET?: string
}

export interface AuthContext {
  uid: string
  email: string
  userId: string
  plan: 'free' | 'pro'
}

export interface DaemonContext {
  teamId: string
  agentId: string
  tokenId: string
}

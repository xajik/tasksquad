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
  // Set in wrangler.toml [vars]
  CLOUDFLARE_ACCOUNT_ID: string
  R2_BUCKET_NAME: string
}

export interface AuthContext {
  uid: string
  email: string
  userId: string
}

export interface DaemonContext {
  teamId: string
  agentId: string
  tokenId: string
}

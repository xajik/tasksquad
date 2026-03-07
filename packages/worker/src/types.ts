export interface Env {
  DB: D1Database
  LOGS: R2Bucket
  JWKS_CACHE: KVNamespace
  AGENT_RELAY: DurableObjectNamespace
  FIREBASE_PROJECT_ID: string
  FIREBASE_SERVICE_ACCOUNT_KEY: string
  DAEMON_SECRET: string
}

export interface AuthContext {
  uid: string
  email: string
  userId: string
}

export interface DaemonContext {
  teamId: string
  tokenId: string
}

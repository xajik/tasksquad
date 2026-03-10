interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
}

function base64url(str: string): string {
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
  }))
  const signingInput = `${header}.${payload}`

  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\n/g, '')
  const keyBuffer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0))

  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  )
  const sig = base64url(Array.from(new Uint8Array(sigBuffer)).map(b => String.fromCharCode(b)).join(''))

  const jwt = `${signingInput}.${sig}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  const data = await res.json<{ access_token: string }>()
  return data.access_token
}

export async function sendFCMNotification(
  serviceAccountB64: string,
  projectId: string,
  token: string,
  title: string,
  body: string,
  taskId: string,
): Promise<void> {
  const sa = JSON.parse(atob(serviceAccountB64)) as ServiceAccount
  const accessToken = await getAccessToken(sa)

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        // Use data-only webpush so the service worker handles display
        // (allows custom icon, badge, click routing).
        webpush: {
          data: { title, body, taskId },
        },
      },
    }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error(`[fcm] send failed ${res.status}: ${detail}`)
  }
}

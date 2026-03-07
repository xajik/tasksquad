import type { Config } from './config.ts'

export async function apiPost<T = Record<string, unknown>>(
  config: Config,
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(config.apiUrl + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-TSQ-Token': token,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(`POST ${path} → ${res.status}: ${JSON.stringify(err)}`)
  }
  return res.json() as Promise<T>
}

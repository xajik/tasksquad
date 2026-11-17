/** A seeded CLI token for the loopback-only development harness; never a production login. */
export function selectLocalGraphToken(
  development: boolean,
  hostname: string,
  apiBase: string | undefined,
  token: string | undefined
): string | null {
  const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  if (!development || !loopback(hostname) || !token || !/^tsq_cli_[a-f0-9]{64}$/.test(token)) return null
  try {
    const api = new URL(apiBase ?? '')
    return api.protocol === 'http:' && loopback(api.hostname) ? token : null
  } catch {
    return null
  }
}

export function localGraphToken(): string | null {
  if (typeof window === 'undefined') return null
  return selectLocalGraphToken(
    import.meta.env.DEV,
    window.location.hostname,
    import.meta.env.VITE_API_BASE_URL,
    import.meta.env.VITE_LOCAL_GRAPH_TOKEN
  )
}

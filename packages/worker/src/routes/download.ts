// Public, unauthenticated download links for the native macOS app.
// The website links to a stable URL; this resolves it to the newest published
// `macos-v*` GitHub release (drafts are invisible to the public API) and
// redirects to its DMG. The REST API is tried first; Cloudflare's shared egress
// IPs routinely exhaust GitHub's unauthenticated API limit, so the public
// releases Atom feed (no rate limit, no drafts) is the fallback, with the DMG
// URL derived from package-app.sh's naming. Successful lookups are edge-cached.

const REPO = 'xajik/tasksquad'
const TAG_PREFIX = 'macos-v'
const CACHE_SECONDS = 600

interface ReleaseAsset { name: string; browser_download_url: string }
interface Release { tag_name: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }

export interface MacRelease { version: string; tag: string; prerelease: boolean; dmg: string; sha256?: string }

export function pickMacRelease(releases: Release[], includePrerelease = true): MacRelease | null {
  for (const r of releases) {
    if (r.draft || !r.tag_name.startsWith(TAG_PREFIX)) continue
    if (r.prerelease && !includePrerelease) continue
    const dmg = r.assets.find(a => a.name.endsWith('.dmg'))
    if (!dmg) continue
    const sha = r.assets.find(a => a.name === `${dmg.name}.sha256`)
    return {
      version: r.tag_name.slice(TAG_PREFIX.length),
      tag: r.tag_name,
      prerelease: r.prerelease,
      dmg: dmg.browser_download_url,
      sha256: sha?.browser_download_url,
    }
  }
  return null
}

// Parses https://github.com/<repo>/releases.atom into Release-shaped entries.
// The feed has no prerelease flag or assets, so both are derived from the tag.
export function releasesFromAtom(xml: string): Release[] {
  const tags = [...xml.matchAll(/<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/g)].map(m => m[1])
  return tags.map(tag => {
    const version = tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag
    const name = `TaskSquad-Native-${version}.dmg`
    const base = `https://github.com/${REPO}/releases/download/${tag}/`
    return {
      tag_name: tag,
      draft: false,
      prerelease: version.includes('-'),
      assets: [
        { name, browser_download_url: base + name },
        { name: `${name}.sha256`, browser_download_url: `${base}${name}.sha256` },
      ],
    }
  })
}

async function fetchReleases(): Promise<Release[] | null> {
  // GitHub lists releases newest first; the daemon's own v* releases are interleaved.
  const api = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, {
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'tasksquad-worker' },
  })
  if (api.ok) return await api.json() as Release[]
  const atom = await fetch(`https://github.com/${REPO}/releases.atom`, { headers: { 'User-Agent': 'tasksquad-worker' } })
  if (atom.ok) return releasesFromAtom(await atom.text())
  console.error(JSON.stringify({ event: 'macos_release_lookup_failed', api: api.status, atom: atom.status }))
  return null
}

async function latestMacRelease(ctx: ExecutionContext, includePrerelease: boolean): Promise<MacRelease | null> {
  const cacheKey = new Request(`https://cache.tasksquad.internal/download/macos/releases`)
  const cache = caches.default
  let res = await cache.match(cacheKey)
  if (!res) {
    const releases = await fetchReleases()
    if (!releases) return null
    res = new Response(JSON.stringify(releases), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
    })
    ctx.waitUntil(cache.put(cacheKey, res.clone()))
  }
  return pickMacRelease(await res.json() as Release[], includePrerelease)
}

// GET /download/macos            → 302 to the newest DMG (prereleases included)
// GET /download/macos?stable=1   → 302 to the newest non-prerelease DMG
// GET /download/macos/latest.json → version metadata for the website / update checks
export async function macos(req: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url)
  const release = await latestMacRelease(ctx, url.searchParams.get('stable') !== '1')
  if (!release) {
    return Response.redirect(`https://github.com/${REPO}/releases`, 302)
  }
  if (url.pathname.endsWith('/latest.json')) {
    return new Response(JSON.stringify(release), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
    })
  }
  return new Response(null, {
    status: 302,
    headers: { Location: release.dmg, 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
  })
}

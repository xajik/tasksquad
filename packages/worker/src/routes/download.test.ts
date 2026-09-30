import { describe, it, expect } from 'vitest'
import { pickMacRelease, releasesFromAtom } from './download.js'

const asset = (name: string) => ({ name, browser_download_url: `https://example.test/${name}` })

describe('pickMacRelease', () => {
  const releases = [
    { tag_name: 'macos-v0.5.0-preview.1', draft: true, prerelease: true, assets: [asset('TaskSquad-Native-0.5.0-preview.1.dmg')] },
    { tag_name: 'v0.3.8', draft: false, prerelease: false, assets: [asset('tsq_darwin_arm64.tar.gz')] },
    { tag_name: 'macos-v0.4.0-preview.2', draft: false, prerelease: true, assets: [
      asset('TaskSquad-Native-0.4.0-preview.2.dmg'), asset('TaskSquad-Native-0.4.0-preview.2.dmg.sha256'),
    ] },
    { tag_name: 'macos-v0.3.9', draft: false, prerelease: false, assets: [asset('TaskSquad-Native-0.3.9.dmg')] },
  ]

  it('skips drafts and daemon releases, includes prereleases by default', () => {
    const r = pickMacRelease(releases)
    expect(r?.version).toBe('0.4.0-preview.2')
    expect(r?.dmg).toBe('https://example.test/TaskSquad-Native-0.4.0-preview.2.dmg')
    expect(r?.sha256).toBe('https://example.test/TaskSquad-Native-0.4.0-preview.2.dmg.sha256')
  })

  it('returns the newest stable release when prereleases are excluded', () => {
    expect(pickMacRelease(releases, false)?.version).toBe('0.3.9')
  })

  it('returns null when no published macOS release has a DMG', () => {
    expect(pickMacRelease(releases.slice(0, 2))).toBeNull()
  })
})

describe('releasesFromAtom', () => {
  const xml = `<feed><id>tag:github.com,2008:https://github.com/xajik/tasksquad/releases</id>
    <entry><id>tag:github.com,2008:Repository/1161597712/v0.3.9</id></entry>
    <entry><id>tag:github.com,2008:Repository/1161597712/macos-v0.4.0-preview.1</id></entry>
    <entry><id>tag:github.com,2008:Repository/1161597712/macos-v0.3.0</id></entry></feed>`

  it('derives DMG URLs and prerelease flags from tags', () => {
    const r = pickMacRelease(releasesFromAtom(xml))
    expect(r?.version).toBe('0.4.0-preview.1')
    expect(r?.prerelease).toBe(true)
    expect(r?.dmg).toBe('https://github.com/xajik/tasksquad/releases/download/macos-v0.4.0-preview.1/TaskSquad-Native-0.4.0-preview.1.dmg')
    expect(pickMacRelease(releasesFromAtom(xml), false)?.version).toBe('0.3.0')
  })
})

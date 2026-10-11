import { describe, expect, it } from 'vitest'
import { MOBILE_REDIRECT_URI, allowedRedirectUri, pkceChallenge, validVerifier } from './mobile-auth.js'

describe('mobile authorization PKCE', () => {
  it('uses the RFC 7636 S256 base64url challenge', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
      .toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('accepts verifier lengths and characters defined by PKCE', () => {
    expect(validVerifier('a'.repeat(43))).toBe(true)
    expect(validVerifier('~._-AZaz09'.repeat(12))).toBe(true)
    expect(validVerifier('a'.repeat(127) + '_')).toBe(true)
    expect(validVerifier('a'.repeat(129))).toBe(false)
    expect(validVerifier('a'.repeat(42))).toBe(false)
    expect(validVerifier('a'.repeat(43) + '+')).toBe(false)
    expect(validVerifier(undefined)).toBe(false)
  })

  it('pins authorization codes to the registered app callback', () => {
    expect(MOBILE_REDIRECT_URI).toBe('tasksquad-portal://oauth/callback')
  })

  it('allows MCP callbacks only when listed exactly', () => {
    const env = { MCP_REDIRECT_URIS: 'https://mcp.example.com/oauth/callback, http://localhost:8788/oauth/callback' }
    expect(allowedRedirectUri(env, MOBILE_REDIRECT_URI)).toBe(true)
    expect(allowedRedirectUri({}, MOBILE_REDIRECT_URI)).toBe(true)
    expect(allowedRedirectUri(env, 'https://mcp.example.com/oauth/callback')).toBe(true)
    expect(allowedRedirectUri(env, 'http://localhost:8788/oauth/callback')).toBe(true)
    expect(allowedRedirectUri(env, 'https://mcp.example.com/oauth/callback?x=1')).toBe(false)
    expect(allowedRedirectUri(env, 'https://evil.example.com/oauth/callback')).toBe(false)
    expect(allowedRedirectUri({}, 'https://mcp.example.com/oauth/callback')).toBe(false)
    expect(allowedRedirectUri(env, undefined)).toBe(false)
  })
})

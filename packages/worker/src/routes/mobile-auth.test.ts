import { describe, expect, it } from 'vitest'
import { MOBILE_REDIRECT_URI, pkceChallenge, validVerifier } from './mobile-auth.js'

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
})

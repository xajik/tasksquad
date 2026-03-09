/**
 * TaskSquad Crypto Utility
 * 
 * Provides AES-256-GCM encryption and DEK (Data Encryption Key) management.
 * DEKs are wrapped using a Master Key (provided as a Worker secret).
 */

const AES_GCM = 'AES-GCM'
const AES_KW = 'AES-KW'

/**
 * Generate a new 256-bit AES-GCM Data Encryption Key.
 */
export async function generateDEK(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey(
    { name: AES_GCM, length: 256 },
    true,
    ['encrypt', 'decrypt']
  )
}

/**
 * Import a Master Key from a raw 256-bit secret.
 */
export async function importMasterKey(raw: string): Promise<CryptoKey> {
  // raw is expected to be a 32-byte hex or base64 string
  const buf = Uint8Array.from(atob(raw), c => c.charCodeAt(0))
  return await crypto.subtle.importKey(
    'raw',
    buf,
    { name: AES_KW },
    false,
    ['wrapKey', 'unwrapKey']
  )
}

/**
 * Wrap a DEK for storage in D1 using the Master Key.
 * Returns a base64 encoded string.
 */
export async function wrapDEK(dek: CryptoKey, masterKey: CryptoKey): Promise<string> {
  const wrapped = await crypto.subtle.wrapKey(
    'raw',
    dek,
    masterKey,
    AES_KW
  )
  return btoa(String.fromCharCode(...new Uint8Array(wrapped)))
}

/**
 * Unwrap a DEK from a base64 string stored in D1.
 */
export async function unwrapDEK(wrappedB64: string, masterKey: CryptoKey): Promise<CryptoKey> {
  const wrapped = Uint8Array.from(atob(wrappedB64), c => c.charCodeAt(0))
  return await crypto.subtle.unwrapKey(
    'raw',
    wrapped,
    masterKey,
    AES_KW,
    { name: AES_GCM },
    true,
    ['encrypt', 'decrypt']
  )
}

/**
 * Export a CryptoKey to a base64 string (for delivery to the Daemon).
 */
export async function exportKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key)
  return btoa(String.fromCharCode(...new Uint8Array(raw)))
}

/**
 * Encrypt data using AES-GCM.
 * Prepend a 12-byte IV to the ciphertext.
 */
export async function encrypt(data: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_GCM, iv },
    key,
    data
  )
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return combined
}

/**
 * Decrypt data using AES-GCM.
 * Expects 12-byte IV prepended to ciphertext.
 */
export async function decrypt(data: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const iv = data.slice(0, 12)
  const ciphertext = data.slice(12)
  const plaintext = await crypto.subtle.decrypt(
    { name: AES_GCM, iv },
    key,
    ciphertext
  )
  return new Uint8Array(plaintext)
}

import { useEffect, useRef, useState } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth, mobileAuth, signInWithGoogleFirstParty, signInWithGitHubRedirect } from '../lib/firebase'

const params = new URLSearchParams(window.location.search)
const redirectUri = params.get('redirect_uri') ?? ''
const challenge = params.get('code_challenge') ?? ''
const state = params.get('state') ?? ''
const expectedRedirect = 'tasksquad-portal://oauth/callback'
const validRequest = redirectUri === expectedRedirect && /^[A-Za-z0-9_-]{43}$/.test(challenge) && /^[A-Za-z0-9-]{20,100}$/.test(state)
const apiBase = import.meta.env.VITE_API_BASE_URL as string

export default function MobileAuth() {
  const [user, setUser] = useState<User | null | false>(null)
  const [status, setStatus] = useState('Checking your account…')
  const [error, setError] = useState('')
  const exchanged = useRef(false)

  useEffect(() => {
    if (!validRequest) {
      setError('This sign-in request is invalid or has expired. Return to TaskSquad and try again.')
      setUser(false)
      return
    }
    if (!auth) {
      setError('Sign-in is temporarily unavailable.')
      setUser(false)
      return
    }
    // Google signs in through the first-party helper (mobileAuth); GitHub still uses the default
    // auth domain, since its OAuth app allows a single callback URL. Whichever signs in first wins.
    const instances = [...new Set([mobileAuth(), auth].filter(a => a !== null))]
    const signedOut = new Set<number>()
    const unsubscribers = instances.map((instance, index) => onAuthStateChanged(instance, async currentUser => {
      if (!currentUser) {
        signedOut.add(index)
        if (signedOut.size === instances.length && !exchanged.current) setUser(false)
        return
      }
      setUser(currentUser)
      if (exchanged.current) return
      exchanged.current = true
      try {
        setStatus('Finishing secure sign-in…')
        const idToken = await currentUser.getIdToken()
        const response = await fetch(`${apiBase}/mobile/authorization/codes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ redirect_uri: redirectUri, code_challenge: challenge }),
        })
        if (!response.ok) throw new Error('Could not create a sign-in code. Return to TaskSquad and try again.')
        const result = await response.json() as { code: string }
        const callback = new URL(redirectUri)
        callback.searchParams.set('code', result.code)
        callback.searchParams.set('state', state)
        window.location.replace(callback.toString())
      } catch (reason) {
        exchanged.current = false
        setError(reason instanceof Error ? reason.message : 'Sign-in failed.')
        setUser(false)
      }
    }))
    return () => unsubscribers.forEach(unsubscribe => unsubscribe())
  }, [])

  async function signIn(provider: 'google' | 'github') {
    setError('')
    setStatus('Opening secure sign-in…')
    setUser(null)
    try {
      if (provider === 'google') await signInWithGoogleFirstParty()
      else await signInWithGitHubRedirect()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign-in failed.')
      setUser(false)
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center px-5">
      <section className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-xl">
        <div className="mb-5 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-500 font-semibold">T</div>
          <div><h1 className="text-lg font-semibold">TaskSquad Portal</h1><p className="text-sm text-slate-400">Sign in to continue on iPhone</p></div>
        </div>
        {user === null && !error ? <p className="text-sm text-slate-300">{status}</p> : user && !error ? <p className="text-sm text-slate-300">{status}</p> : (
          <div className="space-y-3">
            {error && <p role="alert" className="rounded-lg bg-red-950/70 p-3 text-sm text-red-200">{error}</p>}
            <button onClick={() => void signIn('google')} className="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-slate-900">Continue with Google</button>
            <button onClick={() => void signIn('github')} className="w-full rounded-lg border border-white/15 px-4 py-3 text-sm font-medium text-white">Continue with GitHub</button>
            <p className="pt-1 text-xs leading-5 text-slate-400">TaskSquad receives a one-time authorization code. Your account token is returned directly to the app after PKCE verification.</p>
          </div>
        )}
      </section>
    </main>
  )
}

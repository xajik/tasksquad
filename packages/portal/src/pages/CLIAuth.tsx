import { useState, useEffect } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth, signInWithGoogle, signInWithGitHub } from '../lib/firebase'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

const redirectUri = new URLSearchParams(window.location.search).get('redirect_uri') ?? ''

const isSafe =
  redirectUri.startsWith('http://localhost:') ||
  redirectUri.startsWith('http://127.0.0.1:')

console.log('[CLIAuth] module init, redirectUri=', redirectUri, 'isSafe=', isSafe)

async function sendTokens(user: User): Promise<void> {
  const idToken = await user.getIdToken()
  const url = new URL(redirectUri)
  url.searchParams.set('id_token', idToken)
  url.searchParams.set('refresh_token', user.refreshToken)
  url.searchParams.set('email', user.email ?? '')
  window.location.href = url.toString()
}

export default function CLIAuth() {
  // null = loading, User = logged in, false = not logged in
  const [user, setUser] = useState<User | null | false>(null)
  const [error, setError] = useState('')

  console.log('[CLIAuth] render, user=', user, 'isSafe=', isSafe)

  useEffect(() => {
    console.log('[CLIAuth] useEffect, isSafe=', isSafe)
    if (!isSafe) return
    return onAuthStateChanged(auth, (u) => {
      console.log('[CLIAuth] onAuthStateChanged, u=', u?.email ?? null)
      if (u) {
        // Already logged in — send tokens immediately, no interaction needed.
        sendTokens(u).catch((e) => setError(e instanceof Error ? e.message : 'Failed'))
      } else {
        setUser(false)
      }
    })
  }, [])

  async function handleSignIn(provider: 'google' | 'github') {
    setError('')
    setUser(null) // back to loading spinner while popup is open
    try {
      if (provider === 'google') {
        await signInWithGoogle()
      } else {
        await signInWithGitHub()
      }
      // onAuthStateChanged will fire and call sendTokens automatically
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed')
      setUser(false)
    }
  }

  if (!redirectUri || !isSafe) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-[380px]">
          <CardHeader>
            <CardTitle>Invalid request</CardTitle>
            <CardDescription>
              This page is only accessible from the <code>tsq</code> CLI tool.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  // Loading: either waiting for Firebase to restore session, or redirecting.
  if (user === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-[380px]">
          <CardHeader>
            <CardTitle>Connecting…</CardTitle>
            <CardDescription>Checking authentication status</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-[380px]">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold">Sign in to CLI</CardTitle>
          <CardDescription>
            Authenticating the TaskSquad daemon on your machine
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            variant="outline"
            className="w-full flex items-center gap-2"
            onClick={() => handleSignIn('google')}
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0" aria-hidden="true">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </Button>

          <Button
            variant="outline"
            className="w-full flex items-center gap-2"
            onClick={() => handleSignIn('github')}
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0" aria-hidden="true" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
            </svg>
            Continue with GitHub
          </Button>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <p className="text-xs text-center text-muted-foreground pt-1">
            Credentials will be sent to your local <code>tsq</code> process only.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

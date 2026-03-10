import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider, signInWithPopup } from 'firebase/auth'

const app = initializeApp({
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
})

export const auth = getAuth(app)

const googleProvider = new GoogleAuthProvider()

export async function signInWithGoogle(): Promise<void> {
  await signInWithPopup(auth, googleProvider)
}

export async function getToken(): Promise<string | null> {
  const user = auth.currentUser
  if (!user) return null
  return user.getIdToken()
}

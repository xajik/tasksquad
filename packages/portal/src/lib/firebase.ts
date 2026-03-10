import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider, signInWithPopup } from 'firebase/auth'
import { getMessaging, getToken as getFCMTokenRaw } from 'firebase/messaging'

const app = initializeApp({
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
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

export async function getFCMToken(): Promise<string | null> {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return null
  if (Notification.permission !== 'granted') return null
  try {
    const messaging = getMessaging(app)
    const sw = await navigator.serviceWorker.ready
    return await getFCMTokenRaw(messaging, {
      vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
      serviceWorkerRegistration: sw,
    })
  } catch (e) {
    console.error('[fcm] getToken failed:', e)
    return null
  }
}

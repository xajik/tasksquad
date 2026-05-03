import { initializeApp, getApps, type FirebaseApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider, GithubAuthProvider, signInWithPopup } from 'firebase/auth'
import { getMessaging, getToken as getFCMTokenRaw } from 'firebase/messaging'

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
}

let app: FirebaseApp | null = null
let auth: ReturnType<typeof getAuth> | null = null
if (firebaseConfig.appId && firebaseConfig.apiKey) {
  app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig)
  auth = getAuth(app)
} else {
  console.warn('[firebase] Firebase config incomplete, Firebase SDK disabled')
}

export const firebaseAuth = auth as ReturnType<typeof getAuth>
const authExport = auth as unknown as ReturnType<typeof getAuth>
export { authExport as auth }

const googleProvider = new GoogleAuthProvider()
const githubProvider = new GithubAuthProvider()

export async function signInWithGoogle(): Promise<void> {
  if (!auth) throw new Error('Firebase not configured')
  await signInWithPopup(auth, googleProvider)
}

export async function signInWithGitHub(): Promise<void> {
  if (!auth) throw new Error('Firebase not configured')
  await signInWithPopup(auth, githubProvider)
}

export async function getToken(): Promise<string | null> {
  if (!auth) return null
  const user = auth.currentUser
  if (!user) return null
  return user.getIdToken()
}

export async function getFCMToken(): Promise<string | null> {
  if (!app) {
    console.warn('[fcm] Firebase app not initialized')
    return null
  }
  if (!import.meta.env.VITE_FIREBASE_APP_ID) {
    console.warn('[fcm] appId not configured, skipping FCM token registration')
    return null
  }
  if (!import.meta.env.VITE_FIREBASE_VAPID_KEY) {
    console.warn('[fcm] vapidKey not configured, skipping FCM token registration')
    return null
  }
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

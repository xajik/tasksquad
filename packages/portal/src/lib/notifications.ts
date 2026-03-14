import { getFCMToken } from './firebase'
import { trackEvent } from './analytics'

let tokenRegistered = false

/**
 * Get an FCM registration token and persist it to the backend.
 * Safe to call multiple times — no-ops after the first successful registration.
 */
export async function registerPushToken(): Promise<void> {
  if (tokenRegistered) return
  const token = await getFCMToken()
  if (!token) return
  try {
    const { getToken } = await import('./firebase')
    const authToken = await getToken()
    const base = import.meta.env.VITE_API_BASE_URL as string
    await fetch(`${base}/me/push/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authToken ? `Bearer ${authToken}` : '',
      },
      body: JSON.stringify({ token }),
    })
    trackEvent('push_token_registered')
    tokenRegistered = true
  } catch (e) {
    console.error('[fcm] registerPushToken failed:', e)
  }
}

/**
 * Request permission once. Subsequent calls return the current permission.
 * Storing 'denied' in localStorage avoids re-prompting across sessions.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied'
  if (Notification.permission !== 'default') return Notification.permission
  const result = await Notification.requestPermission()
  return result
}

/**
 * Show a notification. Prefers ServiceWorkerRegistration.showNotification()
 * which works when the PWA is in the background on mobile.
 */
export async function notify(title: string, body: string, taskId?: string): Promise<void> {
  if (!('Notification' in window)) return
  if (Notification.permission !== 'granted') return

  const options: NotificationOptions = {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: taskId,
    data: taskId ? { taskId } : undefined,
  }

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready
      await reg.showNotification(title, options)
      trackEvent('notification_shown', { title, taskId })
      return
    } catch {
      // fall through to Notification API
    }
  }

  new Notification(title, options)
  trackEvent('notification_shown', { title, taskId })
}

/** Human-readable label + body for each task status transition. */
export const STATUS_NOTIF: Record<string, { title: (agentName: string) => string; body: (subject: string, preview?: string) => string }> = {
  running:       { title: a => `${a} picked up a task`,  body: s => s },
  waiting_input: { title: a => `${a} needs your input`,  body: (s, p) => p ? `${s} · ${p}` : s },
  done:          { title: a => `${a} completed a task`,  body: s => s },
  failed:        { title: a => `${a} failed`,            body: s => s },
}

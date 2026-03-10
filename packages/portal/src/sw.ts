import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'

declare let self: ServiceWorkerGlobalScope

// Precache all static assets injected by vite-plugin-pwa
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Navigate to the task thread when a notification is clicked
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const taskId = event.notification.data?.taskId as string | undefined
  const url = taskId ? `/dashboard/tasks/${taskId}` : '/dashboard'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        const wc = client as WindowClient
        if ('navigate' in wc) return wc.focus().then(() => wc.navigate(url))
      }
      return self.clients.openWindow(url)
    }),
  )
})

// Handle FCM push messages delivered via Web Push when the app is backgrounded/closed.
// FCM sends data-only payloads so we control the notification display.
self.addEventListener('push', (event) => {
  if (!event.data) return
  let payload: { title?: string; body?: string; taskId?: string } = {}
  try { payload = event.data.json() } catch { return }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'TaskSquad', {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.taskId,
      data: { taskId: payload.taskId },
    }),
  )
})

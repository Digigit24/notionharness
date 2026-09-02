// ROADMAP B5.3 (Batch B-5 "Attention") — minimal Web Push service worker.
// Registered by components/notifications/push-subscribe-toggle.tsx via
// `navigator.serviceWorker.register('/sw.js')`. Deliberately does nothing
// beyond push handling today (no offline caching, no fetch interception) —
// this repo has no PWA/offline requirement; the service worker exists
// solely because the Push API requires one to receive `push` events and
// show a `Notification` from a page that may not even be open.
//
// Payload shape sent from the server: see lib/push/send.ts's `PushMessage`
// — { title, body, url }. `url` (if present) is opened/focused on click.

self.addEventListener('push', (event) => {
  let data = { title: 'NotionForge', body: 'You have a new notification.', url: null }
  try {
    if (event.data) data = { ...data, ...event.data.json() }
  } catch {
    // Non-JSON payload (shouldn't happen — lib/push/send.ts always sends
    // JSON) — fall back to the default body above rather than throwing out
    // of the event handler, which would silently drop the notification.
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/next.svg',
      data: { url: data.url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(url)
          return client.focus()
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url)
      return undefined
    }),
  )
})

'use client'

// ROADMAP B5.3 (Batch B-5 "Attention") — browser-side half of Web Push.
// Pure functions with no React dependency so they're independently testable
// and reusable outside the one settings-page toggle that calls them today.

/** Converts the VAPID public key (URL-safe base64) into the raw byte array
 * `PushManager.subscribe`'s `applicationServerKey` option requires. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i)
  return outputArray
}

export function isPushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null
  const registration = await navigator.serviceWorker.getRegistration('/sw.js')
  if (!registration) return null
  return registration.pushManager.getSubscription()
}

/**
 * Registers public/sw.js, requests Notification permission, subscribes via
 * the Push API, and hands the subscription to the server
 * (POST /api/notifications/subscribe). Throws with a human-readable message
 * on any real failure (unsupported browser, permission denied, no VAPID key
 * configured) — the caller (push-subscribe-toggle.tsx) is responsible for
 * surfacing that to the user, this function doesn't swallow errors since
 * the whole point is the caller needs to know whether it actually worked.
 */
export async function subscribeToPush(): Promise<PushSubscription> {
  if (!isPushSupported()) throw new Error('This browser does not support push notifications.')

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  if (!publicKey) {
    throw new Error('Push notifications are not configured yet (NEXT_PUBLIC_VAPID_PUBLIC_KEY is unset) — ask an admin to generate VAPID keys.')
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notification permission was not granted.')

  const registration = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready

  const existing = await registration.pushManager.getSubscription()
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }))

  const res = await fetch('/api/notifications/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || 'Failed to save the push subscription.')
  }

  return subscription
}

/** Unsubscribes the browser and tells the server to drop the stored row. */
export async function unsubscribeFromPush(): Promise<void> {
  const subscription = await getExistingPushSubscription()
  if (!subscription) return

  const endpoint = subscription.endpoint
  await subscription.unsubscribe()

  await fetch('/api/notifications/subscribe', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).catch(() => undefined)
}

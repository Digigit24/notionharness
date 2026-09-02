'use client'

// ROADMAP B5.3 (Batch B-5 "Attention") — the one control that turns on
// browser push for this device. Lives on the notification settings page
// (app/(app)/settings/notifications/page.tsx). Per-device by nature (a
// PushSubscription is tied to one browser install), so this reflects THIS
// browser's subscription state, not a server-side "push enabled" flag.
import { useEffect, useState } from 'react'
import { BellRing, BellOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getExistingPushSubscription, isPushSupported, subscribeToPush, unsubscribeFromPush } from '@/lib/push/client'

export function PushSubscribeToggle() {
  const [supported, setSupported] = useState<boolean | null>(null)
  const [subscribed, setSubscribed] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSupported(isPushSupported())
    getExistingPushSubscription()
      .then((sub) => setSubscribed(Boolean(sub)))
      .catch(() => setSubscribed(false))
  }, [])

  if (supported === null) return null

  if (!supported) {
    return (
      <p className="text-sm text-muted-foreground">
        This browser does not support push notifications.
      </p>
    )
  }

  async function toggle() {
    setPending(true)
    setError(null)
    try {
      if (subscribed) {
        await unsubscribeFromPush()
        setSubscribed(false)
      } else {
        await subscribeToPush()
        setSubscribed(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant={subscribed ? 'outline' : 'default'}
        size="sm"
        onClick={toggle}
        disabled={pending}
      >
        {subscribed ? <BellOff /> : <BellRing />}
        {pending ? 'Working…' : subscribed ? 'Disable push on this device' : 'Enable push on this device'}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

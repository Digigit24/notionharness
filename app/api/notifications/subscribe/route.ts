import { NextRequest, NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'

// ROADMAP B5.3 (Batch B-5 "Attention") — stores/removes the browser's real
// `PushSubscription` (from `registration.pushManager.subscribe(...)`)
// against the authenticated user. Identity always comes from the session,
// never a client-supplied id — same rule this codebase applies everywhere
// else a client can write (see app/api/approvals/route.ts's comment).
//
// Requires `migrations/20260902_140000_push_notifications.ts` to be applied
// — until then every call here 500s with Postgres's own "relation
// push_subscriptions does not exist," the same honest failure mode every
// other unapplied-migration collection in this repo produces.
export async function POST(req: NextRequest) {
  const user = await getCurrentPayloadUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const subscription = body?.subscription as
    | { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
    | undefined
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return NextResponse.json({ error: 'A full PushSubscription (endpoint + keys.p256dh + keys.auth) is required.' }, { status: 400 })
  }

  const payload = await getPayloadClient()

  // Upsert on `endpoint` (globally unique per the Push API spec) rather than
  // blindly inserting — the browser can re-subscribe the same endpoint
  // (e.g. after clearing site data and re-granting permission) and this
  // must not accumulate duplicate rows that would each get a push attempt.
  const existing = await payload.find({
    collection: 'push-subscriptions',
    where: { endpoint: { equals: subscription.endpoint } },
    limit: 1,
    overrideAccess: true,
  })

  const userAgent = req.headers.get('user-agent') ?? undefined
  if (existing.docs[0]) {
    await payload.update({
      collection: 'push-subscriptions',
      id: existing.docs[0].id,
      data: {
        user: user.id,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent,
      },
      overrideAccess: true,
    })
  } else {
    await payload.create({
      collection: 'push-subscriptions',
      data: {
        user: user.id,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent,
      },
      overrideAccess: true,
    })
  }

  return NextResponse.json({ ok: true })
}

// Unsubscribe — the client calls this after `PushSubscription.unsubscribe()`
// resolves, so the stored row doesn't linger and get pushed to forever.
export async function DELETE(req: NextRequest) {
  const user = await getCurrentPayloadUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const endpoint = body?.endpoint as string | undefined
  if (!endpoint) return NextResponse.json({ error: 'endpoint is required' }, { status: 400 })

  const payload = await getPayloadClient()
  const existing = await payload.find({
    collection: 'push-subscriptions',
    where: { endpoint: { equals: endpoint }, user: { equals: user.id } },
    limit: 1,
    overrideAccess: true,
  })
  if (existing.docs[0]) {
    await payload.delete({ collection: 'push-subscriptions', id: existing.docs[0].id, overrideAccess: true })
  }

  return NextResponse.json({ ok: true })
}

import crypto from 'crypto'
import { getPayloadClient } from '@/lib/payload'
import { getSession } from '@/lib/session'
import type { User } from '@/payload-types'

// Better Auth owns login/session; Payload's `users` collection stays the
// source of truth for app relationships (workspace owner/members, etc).
// This lazily finds-or-creates the Payload user shadowing the Better Auth
// session, linked by email. The random password satisfies Payload's local
// auth strategy on create but is never used — nobody logs into Payload's own
// `/admin` panel with these accounts.
export async function getCurrentPayloadUser(): Promise<User | null> {
  const session = await getSession()
  if (!session) return null

  const payload = await getPayloadClient()
  const existing = await payload.find({
    collection: 'users',
    where: { email: { equals: session.user.email } },
    limit: 1,
    overrideAccess: true,
  })
  if (existing.docs[0]) return existing.docs[0]

  // Real race, not hypothetical: confirmed live this session — Next.js's
  // own post-signup `router.push('/'); router.refresh()` can fire two
  // near-simultaneous requests to this same route, both finding no
  // existing row and both racing to `create` one for the same brand-new
  // email, which `users.email`'s unique constraint then rejects for
  // whichever one loses — surfaced as an opaque "field is invalid: email"
  // 400, not a clear "someone else already created this" message. Losing
  // the create race isn't a real failure here (the row exists now, created
  // by the winner) — re-fetch and return it instead of throwing.
  try {
    return await payload.create({
      collection: 'users',
      data: {
        email: session.user.email,
        name: session.user.name || session.user.email,
        role: 'member',
        password: crypto.randomBytes(32).toString('hex'),
      },
      overrideAccess: true,
    })
  } catch (err) {
    const retry = await payload.find({
      collection: 'users',
      where: { email: { equals: session.user.email } },
      limit: 1,
      overrideAccess: true,
    })
    if (retry.docs[0]) return retry.docs[0]
    throw err
  }
}

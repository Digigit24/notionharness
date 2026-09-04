import { NextResponse } from 'next/server'

import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import { logger } from '@/lib/logger'

/**
 * Phase 0 — the gate on the two routes an external loop polls.
 *
 * `POST /api/dispatcher/tick` drives the whole dispatcher: it claims a queued
 * run and hands it to a detached execution task, which spawns a real agent
 * binary on this host. `POST /api/runtimes/health-check` starts the Hermes
 * dashboard server if it is not already up. Both were reachable by anyone who
 * could resolve the hostname — verified live before this file existed, `POST`
 * with no headers at all answering `200 {"claimed":false,...}`.
 *
 * TWO WAYS IN, because there are two legitimate callers with nothing in
 * common. `scripts/run-dispatcher-loop.ts` is a headless process with no
 * cookie jar and no Payload import (deliberately — see its header on the
 * connection-pool reason), so it can only ever present a shared secret. The
 * runtimes page's "Refresh" button is a person in a browser, who has a session
 * and no way to learn a server-side secret. Supporting only one of the two
 * would break the other.
 *
 * WHAT HAPPENS WHEN THE SECRET IS NOT SET, which is the only interesting
 * decision here. Refusing unconditionally is the obvious fail-closed answer
 * and it is wrong: it stops the dispatcher on every existing development
 * install the moment this ships, for a route that on a laptop is reachable
 * only from that laptop. Allowing unconditionally is what we are fixing. So it
 * splits on the build, which is the one signal that actually distinguishes the
 * two situations — a public host runs a production build, a laptop does not:
 *
 *   - secret set          → the secret must match, or a workspace admin's session.
 *   - unset, development  → allowed, with a warning that names the variable.
 *   - unset, production   → refused, with a message that names the variable.
 *
 * REJECTED ALTERNATIVE: trusting a loopback source address instead of a
 * secret. Behind any reverse proxy every request appears to come from
 * loopback, so that check would be strongest exactly where it is weakest.
 */
const SECRET = process.env.DISPATCHER_SECRET || ''
const HEADER = 'x-dispatcher-secret'

let warnedAboutMissingSecret = false

/** Timing-safe enough for a fixed-length secret compared per request: the
 * lengths are compared first (which leaks only the length) and the bytes
 * without early exit. `crypto.timingSafeEqual` would throw on a length
 * mismatch, which is the branch an attacker measures anyway. */
function secretMatches(presented: string): boolean {
  if (presented.length !== SECRET.length) return false
  let diff = 0
  for (let i = 0; i < SECRET.length; i++) diff |= presented.charCodeAt(i) ^ SECRET.charCodeAt(i)
  return diff === 0
}

/** Owner or admin of at least one workspace, or the install's operator. The
 * `administer` line from `lib/permissions` — a `member` may work in a
 * workspace without being able to drive its dispatcher by hand. */
async function isAdministrator(): Promise<boolean> {
  const user = await getCurrentPayloadUser()
  if (!user) return false
  if (user.role === 'admin') return true
  const payload = await getPayloadClient()
  const found = await payload.count({
    collection: 'workspace-members',
    where: { and: [{ user: { equals: user.id } }, { role: { in: ['owner', 'admin'] } }] },
    overrideAccess: true,
  })
  return found.totalDocs > 0
}

/** Returns a refusal Response, or null when the caller may proceed. */
export async function requireInternalCaller(request: Request, routeName: string): Promise<Response | null> {
  if (SECRET) {
    const presented = request.headers.get(HEADER) ?? ''
    if (presented && secretMatches(presented)) return null
    if (await isAdministrator()) return null
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      {
        error:
          'DISPATCHER_SECRET is not set, so this route is closed. Set it in the environment and send it as the X-Dispatcher-Secret header.',
      },
      { status: 503 },
    )
  }

  if (!warnedAboutMissingSecret) {
    warnedAboutMissingSecret = true
    logger.warn('internal route is unauthenticated because DISPATCHER_SECRET is unset', {
      route: routeName,
      note: 'Allowed in development only. A production build refuses this route until the variable is set.',
    })
  }
  return null
}

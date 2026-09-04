import { NextRequest, NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { syncConnection } from '@/lib/connectors/sync'
import { bestEffort, reportFailure } from '@/lib/failures'
import { resolveApproval } from '@/lib/hermes/approval-helpers'
import { connectionIdFromRequest, connectRequestPrefix } from '@/lib/hermes/connect-request'
import type { ApprovalStatus } from '@/collections/Approvals'
import type { Connection, Workspace } from '@/payload-types'

/**
 * Where Composio sends the browser after a person finishes authorising.
 *
 * THE QUERYSTRING CARRIES ONE THING: our own `connections` row id. Not a
 * status, not a toolkit, not a return URL. Everything else is read back from
 * Composio by `syncConnection`, which also verifies that the connected account
 * belongs to the entity id derived from that row's own user. A callback that
 * believed `?status=success` would be a URL anybody could type to mark
 * themselves connected to a mailbox they never authorised, and one that
 * believed `?return=` would be an open redirect on a route a third party
 * points browsers at — the destination below is derived from the row instead.
 *
 * IDENTITY COMES FROM THE SESSION. A person will refresh this URL, will paste
 * it to themselves, will leave it in a history somebody else opens. The row is
 * only reconciled when the signed-in user owns it, and the refusal is a
 * redirect to the connectors screen rather than a 403 page: they are standing
 * in a browser mid-flow, and a JSON error is a dead end with no way back.
 *
 * IDEMPOTENT BY CONSTRUCTION. It performs no state transition of its own — it
 * asks Composio and stores the answer — so five refreshes produce the same row
 * five times, and `syncConnection` writes the audit entry only on the
 * transition INTO active.
 */
export async function GET(req: NextRequest) {
  const connectionId = Number(req.nextUrl.searchParams.get('connection'))
  if (!Number.isFinite(connectionId) || connectionId <= 0) {
    return NextResponse.json({ error: 'A connection id is required.' }, { status: 400 })
  }

  const user = await getCurrentPayloadUser()
  if (!user) {
    // The consent screen took long enough for a session to lapse. Sending them
    // to login loses which connection they were finishing, so the connectors
    // screen is the destination after they sign in — the row is still there and
    // still pending, and the poller picks it up.
    const back = new URL('/login', req.nextUrl.origin)
    return NextResponse.redirect(back)
  }

  const payload = await getPayloadClient()
  const row = (await payload.findByID({
    collection: 'connections',
    id: connectionId,
    // depth 1 so the workspace comes back populated: the redirect below needs
    // its slug, and a second query for one string is a round trip a person is
    // waiting on mid-redirect.
    depth: 1,
    overrideAccess: true,
    disableErrors: true,
  })) as (Connection & { workspace: Workspace | number }) | null

  const ownerId = row && (typeof row.user === 'number' ? row.user : row.user.id)
  if (!row || ownerId !== user.id) {
    // Same wording for "no such row" and "not yours", so the id cannot be
    // probed by watching which one comes back.
    return NextResponse.json({ error: 'That connection no longer exists.' }, { status: 404 })
  }

  const workspace = typeof row.workspace === 'number' ? null : row.workspace
  const workspaceId = typeof row.workspace === 'number' ? row.workspace : row.workspace.id

  let outcome: 'connected' | 'pending' | 'failed' = 'pending'
  try {
    const result = await syncConnection({ connectionId, viewerUserId: user.id, workspaceId })
    outcome = result.status === 'active' ? 'connected' : result.status === 'pending' ? 'pending' : 'failed'
  } catch (err) {
    // Cannot become an error page: the person is mid-redirect and would have no
    // way back to the screen they started from. Logged properly, and the
    // destination shows the connection's real state — still pending, still with
    // a Connect button.
    reportFailure(err, 'connector callback could not verify the connection', { connectionId })
    outcome = 'failed'
  }

  // A run may be parked on this exact connection (`connect_app` in
  // `lib/teams/tools.ts`). Settling its approval here is what makes the turn
  // resume by itself — the person finishes at the third party, the browser
  // lands back on this route, and the agent carries on without anybody
  // pressing anything. The wait may be held in another process entirely, which
  // is why `resolveApproval` announces over LISTEN/NOTIFY rather than only
  // resolving an in-memory waiter.
  //
  // `pending` is deliberately NOT settled: Composio's INITIALIZING/INITIATED
  // means the person is still going, and waking the run to tell it "not
  // connected" while the consent screen is still open would end the flow that
  // was about to succeed.
  if (outcome !== 'pending') {
    await settleParkedConnectRequest(connectionId, user.id, outcome === 'connected')
  }

  const destination = workspace?.slug
    ? `/workspace/${workspace.slug}/settings/connectors?connection=${connectionId}&result=${outcome}`
    : '/'
  return NextResponse.redirect(new URL(destination, req.nextUrl.origin))
}

/**
 * Ends the wait of whatever run asked for this connection.
 *
 * Scoped three ways, and each one is load-bearing. To `pending`, so a refresh
 * of this URL cannot reopen and re-settle a request that already resolved. To
 * the signed-in user, because the approval belongs to the person it was raised
 * against and this route is reachable by anyone holding the link. And the
 * parsed connection id is re-checked in code rather than trusted to the `like`
 * match, because a prefix search is a substring search and reasoning about
 * which ids it cannot also match is exactly the kind of argument that stops
 * being true when the id format changes.
 *
 * Best-effort: the connection itself is already reconciled and stored by the
 * time this runs. A failure here costs the parked run its fast resume — it
 * falls back to the ten-second poll in `waitForApproval` — and must not turn
 * a completed authorisation into an error page for somebody mid-redirect.
 */
async function settleParkedConnectRequest(connectionId: number, userId: number, connected: boolean): Promise<void> {
  await bestEffort(
    async () => {
      const payload = await getPayloadClient()
      const pending: ApprovalStatus = 'pending'
      const found = await payload.find({
        collection: 'approvals',
        where: {
          and: [
            { externalId: { like: connectRequestPrefix(connectionId) } },
            { status: { equals: pending } },
            { requestedUser: { equals: userId } },
          ],
        },
        limit: 10,
        depth: 0,
        overrideAccess: true,
      })
      for (const row of found.docs) {
        const externalId = String((row as { externalId?: unknown }).externalId ?? '')
        if (connectionIdFromRequest(externalId) !== connectionId) continue
        await resolveApproval(row.id as number, {
          approved: connected,
          selectedOptionId: connected ? 'connected' : undefined,
          reason: connected ? undefined : 'connection_failed',
        })
      }
    },
    'the connection is already reconciled; a parked run falls back to its own poll',
    { connectionId },
  )
}

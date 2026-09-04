import { NextRequest, NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { syncConnection } from '@/lib/connectors/sync'
import { reportFailure } from '@/lib/failures'
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

  const destination = workspace?.slug
    ? `/workspace/${workspace.slug}/settings/connectors?connection=${connectionId}&result=${outcome}`
    : '/'
  return NextResponse.redirect(new URL(destination, req.nextUrl.origin))
}

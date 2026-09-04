import { NextRequest, NextResponse } from 'next/server'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import { getApprovalByExternalId } from '@/lib/hermes/approval-helpers'
import { connectionIdFromRequest } from '@/lib/hermes/connect-request'
import type { Connection, Workspace } from '@/payload-types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * "Connect" on a parked connect request: a redirect to that person's own
 * authorisation URL.
 *
 * WHY THIS IS A REDIRECT AND NOT A URL IN THE PAYLOAD. The channel strip is
 * rendered to EVERY member of the channel — that is deliberate, so nobody
 * watches an agent that has apparently stalled — and only the accountable
 * person may act on it. Shipping the authorisation link inside that payload
 * would hand a personal, single-use OAuth link to everyone in the room, where
 * anyone could open it and attach their own account to somebody else's
 * connection row. The link therefore never leaves the server: both the
 * transcript card and the channel strip point at this route, it checks who is
 * asking, and it is the only thing that ever sees the URL.
 *
 * The destination is not user-controlled and cannot be made so: it is read
 * from the `connections` row, where it was written from Composio's own
 * response. Nothing in this request contributes to it beyond naming which row
 * to look at, and that row must belong to the person asking.
 *
 * IT DECIDES NOTHING. Opening the consent screen is not consent, so this makes
 * no change to the approval or the connection. The request is settled by
 * `/api/connectors/callback` once the third party has actually said yes.
 */
export async function GET(req: NextRequest) {
  const externalId = req.nextUrl.searchParams.get('request') ?? ''
  const connectionId = connectionIdFromRequest(externalId)
  if (connectionId === null) {
    return NextResponse.json({ error: 'That is not a connection request.' }, { status: 400 })
  }

  const user = await getCurrentPayloadUser()
  if (!user) {
    // A person standing in a browser, mid-flow. A 401 body is a dead end with
    // no way back, so send them to sign in — the request is still pending
    // afterwards and the card still offers the same button.
    return NextResponse.redirect(new URL('/login', req.nextUrl.origin))
  }

  // Pending only, and the requester only. `getApprovalByExternalId` already
  // scopes to `pending`, so a settled request cannot be reopened by revisiting
  // this URL, and the ownership check below is the same one `/api/approvals`
  // applies to a decision.
  const approval = await getApprovalByExternalId(externalId)
  if (!approval || approval.requestedUser !== user.id) {
    // One answer for "no such request" and for "not yours", so the id cannot
    // be probed by watching which one comes back.
    return NextResponse.json({ error: 'That request is no longer waiting.' }, { status: 404 })
  }

  const payload = await getPayloadClient()
  const row = (await payload.findByID({
    collection: 'connections',
    id: connectionId,
    // depth 1 for the workspace slug: every fallback below lands on that
    // workspace's connectors screen, and a second query for one string is a
    // round trip a person is waiting on mid-click.
    depth: 1,
    overrideAccess: true,
    disableErrors: true,
  })) as (Connection & { workspace: Workspace | number }) | null

  const ownerId = row && (typeof row.user === 'number' ? row.user : row.user.id)
  if (!row || ownerId !== user.id) {
    return NextResponse.json({ error: 'That request is no longer waiting.' }, { status: 404 })
  }

  const workspace = typeof row.workspace === 'number' ? null : row.workspace
  const connectorsScreen = workspace?.slug ? `/workspace/${workspace.slug}/settings/connectors` : '/'

  // `syncConnection` clears `redirectUrl` the moment the account goes live,
  // precisely so a spent consent screen cannot be reopened. Landing on the
  // connectors screen is the honest destination in that case: it shows the
  // connection's real state, which is the thing the person came to find out.
  if (!row.redirectUrl) {
    return NextResponse.redirect(new URL(connectorsScreen, req.nextUrl.origin))
  }

  return NextResponse.redirect(row.redirectUrl)
}

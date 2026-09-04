import { NextRequest, NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { loadAccess, can } from '@/lib/permissions'
import { refreshPendingConnections } from '@/lib/connectors/sync'
import { reportFailure } from '@/lib/failures'
import type { Connection } from '@/payload-types'

/**
 * The signed-in person's own connection statuses in one workspace.
 *
 * WHY THIS IS A POLL, AND WHY THAT IS ACCEPTABLE HERE WHEN D0 SAYS IT IS NOT.
 * D0's rule is against polling for state a push already carries: a run's
 * events, a queue depth, a presence list all have a live channel, and polling
 * them spends a request to learn nothing. This state does not change here. It
 * changes at GOOGLE, in a different browser tab, and the only push that could
 * carry it is a Composio connection-completed webhook that this deployment has
 * not confirmed exists — `docs/HANDOFF-ENTERPRISE.md` flags exactly that as
 * unverified, and building a waiter on an unverified webhook is how a person
 * ends up staring at a spinner that will never resolve.
 *
 * What makes it defensible rather than merely unavoidable is the BOUND. The
 * client calls this only while at least one of its rows says `pending`, which
 * is a window a human opened deliberately by pressing Connect and closes by
 * finishing. There is no idle poll: with nothing pending, this route does one
 * indexed database read, makes no Composio call at all, and the client stops
 * calling it on the first response with no pending row in it.
 *
 * IT IS ALSO THE CHEAP PATH ON PURPOSE. The Composio round trip happens only
 * for rows that are pending; every other row is returned from our own database.
 * A poll that re-checked twelve active connections every two seconds would burn
 * a rate limit that is shared across the whole Composio organisation.
 */
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('workspace')
  if (!slug) return NextResponse.json({ error: 'A workspace is required.' }, { status: 400 })

  const [user, workspace] = await Promise.all([getCurrentPayloadUser(), getWorkspaceBySlug(slug)])
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!workspace) return NextResponse.json({ error: 'That workspace no longer exists.' }, { status: 404 })

  const access = await loadAccess(user.id, workspace.id)
  if (!can(access, 'read', 'workspace')) {
    return NextResponse.json({ error: 'You do not have access to this workspace.' }, { status: 403 })
  }

  const payload = await getPayloadClient()
  // Identity is the SESSION's, never a parameter. A `?user=` here would let any
  // member read whose mailbox everybody else had authorised, which is the one
  // fact `collections/Connections.ts` is shaped to keep per-person.
  const before = await payload.find({
    collection: 'connections',
    where: { and: [{ workspace: { equals: workspace.id } }, { user: { equals: user.id } }] },
    limit: 200,
    depth: 0,
    overrideAccess: true,
  })

  const hasPending = before.docs.some((row) => row.status === 'pending')
  if (hasPending) {
    try {
      await refreshPendingConnections({ workspaceId: workspace.id, viewerUserId: user.id })
    } catch (err) {
      // A Composio outage must not blank the screen. The stored statuses below
      // are still true — they are just older than we hoped.
      reportFailure(err, 'connector status poll could not reach Composio', { workspaceId: workspace.id })
    }
  }

  const after = hasPending
    ? await payload.find({
        collection: 'connections',
        where: { and: [{ workspace: { equals: workspace.id } }, { user: { equals: user.id } }] },
        limit: 200,
        depth: 0,
        overrideAccess: true,
      })
    : before

  const docs = (after.docs as Connection[]).map((row) => ({
    id: row.id,
    toolkitSlug: row.toolkitSlug,
    status: row.status,
    statusDetail: row.statusDetail ?? null,
    // No `composioConnectedAccountId` and no `redirectUrl`. The account id is
    // an opaque handle rather than a credential, but it is also of no use to a
    // screen, and the authorisation link is a URL that completes a consent
    // flow — neither belongs in a response the client polls on an interval.
  }))

  return NextResponse.json({
    docs,
    /** The client's own stop condition, computed here so the two cannot
     * disagree about what "still waiting" means. */
    pending: docs.some((row) => row.status === 'pending'),
  })
}

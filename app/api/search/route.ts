import { NextResponse } from 'next/server'
import type { Where } from 'payload'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { loadAccess } from '@/lib/permissions'

/**
 * Phase 0 — full-text search, scoped to the caller.
 *
 * WHAT WAS WRONG. This route took `workspaceId` as an OPTIONAL query parameter
 * and applied it as a filter only when present, with no session check at all:
 * `GET /api/search?q=password` returned matching pages — titles and
 * `plainTextContent` — from every workspace in the install to anybody who
 * could reach the host. Confirmed live before this change.
 *
 * WHAT IT DOES NOW. A caller's own membership decides the scope, and the
 * request cannot widen it. `workspaceId` survives as a NARROWING filter
 * because that is what the command bar sends it for, but it is intersected
 * with membership rather than trusted: naming a workspace you are not in
 * returns nothing rather than everything.
 *
 * REJECTED ALTERNATIVE: requiring `workspaceId` and calling `requireAccess`
 * on it. That reads stricter and is in fact weaker for the caller who omits
 * it — the global command bar legitimately searches across everything the
 * person can see, and making the parameter mandatory would have pushed that
 * screen into sending a workspace it picked, which is the same trust in a
 * client-supplied id wearing a different hat.
 */
export async function GET(req: Request) {
  const user = await getCurrentPayloadUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') || '').trim()
  const requestedWorkspaceId = Number(searchParams.get('workspaceId'))

  if (!q) {
    return NextResponse.json({ docs: [] })
  }

  const payload = await getPayloadClient()

  // One query for membership, read directly rather than through
  // `lib/permissions`'s `loadAccess`: that call answers about ONE workspace,
  // and the question here is "all of them". `loadAccess` is still used below
  // for the narrowing case, where there is a single workspace to ask about.
  const members = await payload.find({
    collection: 'workspace-members',
    where: { user: { equals: user.id } },
    limit: 500,
    depth: 0,
    overrideAccess: true,
  })
  const myWorkspaceIds = members.docs
    .map((doc) => (typeof doc.workspace === 'object' && doc.workspace ? doc.workspace.id : doc.workspace))
    .filter((id): id is number => typeof id === 'number')

  if (myWorkspaceIds.length === 0) {
    return NextResponse.json({ docs: [] })
  }

  let scopedWorkspaceIds = myWorkspaceIds
  if (Number.isFinite(requestedWorkspaceId) && searchParams.get('workspaceId')) {
    // `read` on the workspace itself, so a viewer can search and somebody who
    // was removed from a workspace cannot keep searching it with a stale tab.
    const access = await loadAccess(user.id, requestedWorkspaceId)
    if (!access.role) return NextResponse.json({ docs: [] })
    scopedWorkspaceIds = [requestedWorkspaceId]
  }

  const filters: Where[] = [
    { workspace: { in: scopedWorkspaceIds } },
    { isArchived: { equals: false } },
    { or: [{ title: { like: q } }, { plainTextContent: { like: q } }] },
  ]

  const result = await payload.find({
    collection: 'pages',
    where: { and: filters },
    limit: 50,
    overrideAccess: true,
  })

  return NextResponse.json({ docs: result.docs })
}

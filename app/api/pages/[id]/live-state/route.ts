import { NextResponse } from 'next/server'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import { getBrokerPool } from '@/lib/broker/db'

const NON_TERMINAL_STATUSES = ['queued', 'dispatched', 'running', 'waiting_directory']

/**
 * ROADMAP 6.1 — the client-side half of "streams blocks into the page as it
 * works." The server-side docState merge (applyDocSync) already makes an
 * agent's out-of-band writes safe to persist concurrently with a human's
 * edits; this is what lets an already-open tab actually *see* them without
 * a reload. Workspace membership is re-checked on every poll (same as
 * `enqueuePageRun`) — a page's live docState is not public to any logged-in
 * user just because they can guess its id. Only returns the (larger)
 * docState update when a non-terminal run actually targets this page, so an
 * idle open page never pays for a doc fetch, just the access check.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentPayloadUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const pageId = Number(id)
  if (!Number.isSafeInteger(pageId)) {
    return NextResponse.json({ error: 'Invalid page id' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  const page = await payload
    .findByID({ collection: 'pages', id: pageId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 })
  }
  const workspaceId = typeof page.workspace === 'number' ? page.workspace : page.workspace?.id
  if (typeof workspaceId !== 'number') {
    return NextResponse.json({ error: 'Page has no workspace' }, { status: 404 })
  }
  const workspace = await payload
    .findByID({ collection: 'workspaces', id: workspaceId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  }
  const ownerId = typeof workspace.owner === 'number' ? workspace.owner : workspace.owner?.id
  const memberIds = Array.isArray(workspace.members)
    ? workspace.members.map((member) => (typeof member === 'number' ? member : member.id))
    : []
  if (ownerId !== user.id && !memberIds.includes(user.id)) {
    return NextResponse.json({ error: 'You do not have access to this page.' }, { status: 403 })
  }

  const pool = getBrokerPool()
  const active = await pool.query(`SELECT 1 FROM runs WHERE page_id = $1 AND status = ANY($2::text[]) LIMIT 1`, [
    pageId,
    NON_TERMINAL_STATUSES,
  ])
  const hasActiveRun = (active.rowCount ?? 0) > 0
  if (!hasActiveRun) {
    return NextResponse.json({ hasActiveRun: false, update: null })
  }

  const update =
    page?.docState && typeof page.docState === 'object' && 'update' in (page.docState as object)
      ? (page.docState as { update: unknown }).update
      : null

  return NextResponse.json({ hasActiveRun: true, update: typeof update === 'string' ? update : null })
}

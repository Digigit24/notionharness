import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getPayloadClient } from '@/lib/payload'
import { getBrokerPool } from '@/lib/broker/db'

const NON_TERMINAL_STATUSES = ['queued', 'dispatched', 'running', 'waiting_directory']

/**
 * ROADMAP 6.1 — the client-side half of "streams blocks into the page as it
 * works." The server-side docState merge (applyDocSync) already makes an
 * agent's out-of-band writes safe to persist concurrently with a human's
 * edits; this is what lets an already-open tab actually *see* them without
 * a reload. Deliberately cheap when nothing's happening: only returns the
 * (larger) docState update when a non-terminal run actually targets this
 * page, so an idle open page costs one indexed `runs` lookup per poll, not
 * a doc fetch.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const pageId = Number(id)
  if (!Number.isSafeInteger(pageId)) {
    return NextResponse.json({ error: 'Invalid page id' }, { status: 400 })
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

  const payload = await getPayloadClient()
  const page = await payload
    .findByID({ collection: 'pages', id: pageId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  const update =
    page?.docState && typeof page.docState === 'object' && 'update' in (page.docState as object)
      ? (page.docState as { update: unknown }).update
      : null

  return NextResponse.json({ hasActiveRun: true, update: typeof update === 'string' ? update : null })
}

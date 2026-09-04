import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'

// NOTION-PARITY 2 — generalized replacement for the old
// `for-teable-record` route: finds or creates the `pages` doc paired with a
// row from any DataSource backend, per `collections/Pages.ts`'s
// `linkedSourceType`/`linkedSourceId`/`linkedRecordId`. No 'teable' variant —
// Teable is being dropped entirely (roadmap pivot); a `sourceType` outside
// the two supported backends is a clear 400, not a silent/misleading pair.
/** Titles this route generated itself, which it is therefore free to
 * replace. `Record <id>` is the old placeholder; `Untitled row` is the
 * current one. Anything else was typed by a person and is left alone. */
function isPlaceholderTitle(title: string | null | undefined): boolean {
  if (!title) return true
  return /^Record\s+\S+$/.test(title.trim()) || title.trim() === 'Untitled row'
}

/** How wide a row title is allowed to be before it stops being a title. */
const MAX_ROW_TITLE = 120

/**
 * A human title for the page paired with a table row.
 *
 * This used to be `Record <opaque id>`, which is the id the URL already
 * carries and tells a reader nothing. The row's real name lives in its
 * primary cell, and the rest of the app already knows how to find it: the
 * user-database source treats the first field as primary
 * (`user-database-data-source.ts`), the payload source prefers an explicit
 * `isPrimary` flag and falls back to the first field
 * (`payload-data-source.ts`). Mirrored here rather than imported because
 * those modules are client-side editor code.
 *
 * Returns null when there is nothing usable, so the caller can fall back to
 * a readable placeholder instead of to the id.
 */
async function resolveRowTitle(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  sourceType: 'userDatabase' | 'payload',
  sourceId: string,
  recordId: string,
): Promise<string | null> {
  if (sourceType !== 'userDatabase') return null
  try {
    const [database, row] = await Promise.all([
      payload.findByID({
        collection: 'databases',
        id: Number(sourceId),
        depth: 0,
        overrideAccess: true,
        disableErrors: true,
      }),
      payload.findByID({
        collection: 'database-rows',
        id: Number(recordId),
        depth: 0,
        overrideAccess: true,
        disableErrors: true,
      }),
    ])
    if (!database || !row) return null

    const fields = Array.isArray(database.fields)
      ? (database.fields as Array<{ id?: string; isPrimary?: boolean }>)
      : []
    const primaryFieldId = fields.find((field) => field.isPrimary)?.id ?? fields[0]?.id
    if (!primaryFieldId) return null

    const cells = row.cells && typeof row.cells === 'object' ? (row.cells as Record<string, unknown>) : {}
    const raw = cells[primaryFieldId]
    // A cell can hold a number, a date, or a select object; only a non-empty
    // scalar makes a sensible title.
    const text =
      typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : ''
    const clean = text.trim().replace(/\s+/g, ' ')
    if (!clean) return null
    return clean.length > MAX_ROW_TITLE ? `${clean.slice(0, MAX_ROW_TITLE - 1)}…` : clean
  } catch {
    // A title is a nicety; never fail the pairing over one.
    return null
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const sourceType = searchParams.get('sourceType')
  const sourceId = searchParams.get('sourceId')
  const recordId = searchParams.get('recordId')

  if (!sourceId || !recordId) {
    return NextResponse.json({ error: 'sourceId and recordId are required.' }, { status: 400 })
  }
  if (sourceType !== 'userDatabase' && sourceType !== 'payload') {
    return NextResponse.json({ error: `Rows from source type "${sourceType}" can't be paired with a page.` }, { status: 400 })
  }

  const payload = await getPayloadClient()

  let workspaceId: number
  if (sourceType === 'userDatabase') {
    const databaseId = Number(sourceId)
    if (!Number.isFinite(databaseId)) return NextResponse.json({ error: 'Invalid sourceId.' }, { status: 400 })
    const database = await payload
      .findByID({ collection: 'databases', id: databaseId, depth: 0, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    if (!database) return NextResponse.json({ error: 'Database not found.' }, { status: 404 })
    workspaceId = typeof database.workspace === 'object' ? database.workspace.id : database.workspace
  } else {
    // A Payload collection doc has no single, universal "owning workspace"
    // relationship name to introspect generically (unlike `databases`), so
    // the caller supplies it directly — same as how `PayloadDataSource`
    // itself is constructed with an explicit `workspaceId`, not one it reads
    // off the record.
    const workspaceParam = searchParams.get('workspaceId')
    const parsed = Number(workspaceParam)
    if (!Number.isFinite(parsed)) return NextResponse.json({ error: 'workspaceId is required for a payload-sourced record.' }, { status: 400 })
    workspaceId = parsed
  }

  const existing = await payload.find({
    collection: 'pages',
    where: {
      and: [{ linkedSourceType: { equals: sourceType } }, { linkedSourceId: { equals: sourceId } }, { linkedRecordId: { equals: recordId } }],
    },
    limit: 1,
    overrideAccess: true,
  })
  // Resolved for both branches. On create it names the page; on read it
  // repairs pages created before this route knew how to title them, and
  // keeps a title current when the row was renamed. Only ever overwrites a
  // machine-generated placeholder — a title a person typed is left alone.
  const rowTitle = await resolveRowTitle(payload, sourceType, sourceId, recordId)
  const found = existing.docs[0]
  if (found && rowTitle && rowTitle !== found.title && isPlaceholderTitle(found.title)) {
    await payload
      .update({ collection: 'pages', id: found.id, data: { title: rowTitle }, overrideAccess: true })
      .catch(() => null)
    found.title = rowTitle
  }
  const page =
    found ||
    (await payload.create({
      collection: 'pages',
      data: {
        // Never the raw id: it is already in the URL and means nothing to a
        // reader. A row with an empty primary cell gets a placeholder that
        // at least reads as English.
        title: rowTitle ?? 'Untitled row',
        workspace: workspaceId,
        linkedSourceType: sourceType,
        linkedSourceId: sourceId,
        linkedRecordId: recordId,
      },
      overrideAccess: true,
    }))

  return NextResponse.json({
    pageId: page.id,
    workspaceId: typeof page.workspace === 'object' ? page.workspace.id : page.workspace,
    title: page.title,
    icon: page.icon ?? null,
    coverImage: page.coverImage ?? null,
    docState: page.docState,
  })
}

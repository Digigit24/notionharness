import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'

// NOTION-PARITY 2 — generalized replacement for the old
// `for-teable-record` route: finds or creates the `pages` doc paired with a
// row from any DataSource backend, per `collections/Pages.ts`'s
// `linkedSourceType`/`linkedSourceId`/`linkedRecordId`. No 'teable' variant —
// Teable is being dropped entirely (roadmap pivot); a `sourceType` outside
// the two supported backends is a clear 400, not a silent/misleading pair.
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
  const page =
    existing.docs[0] ||
    (await payload.create({
      collection: 'pages',
      data: {
        title: `Record ${recordId}`,
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

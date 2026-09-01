import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const teableTableId = searchParams.get('teableTableId')
  const recordId = searchParams.get('recordId')
  if (!teableTableId || !recordId) return NextResponse.json({ error: 'teableTableId and recordId are required.' }, { status: 400 })
  const payload = await getPayloadClient()
  const connection = await payload.find({ collection: 'teable-databases', where: { teableTableId: { equals: teableTableId } }, limit: 1, overrideAccess: true })
  const database = connection.docs[0] as unknown as { workspace: number } | undefined
  if (!database) return NextResponse.json({ error: 'Teable connection not found.' }, { status: 404 })
  const existing = await payload.find({ collection: 'pages', where: { and: [{ linkedTeableTableId: { equals: teableTableId } }, { linkedTeableRecordId: { equals: recordId } }] }, limit: 1, overrideAccess: true })
  const page = existing.docs[0] || await payload.create({ collection: 'pages', data: { title: `Record ${recordId}`, workspace: database.workspace, linkedTeableTableId: teableTableId, linkedTeableRecordId: recordId } as never, overrideAccess: true })
  return NextResponse.json({
    pageId: page.id,
    workspaceId: typeof page.workspace === 'object' ? page.workspace.id : page.workspace,
    title: page.title,
    icon: page.icon ?? null,
    coverImage: page.coverImage ?? null,
    docState: page.docState,
  })
}

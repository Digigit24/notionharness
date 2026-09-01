import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'
import { isAllowedCollection, PAYLOAD_DATASOURCE_COLLECTIONS, type PayloadPropertyDef } from '../../../_lib'

/** Updates one mapped property on a doc — never an arbitrary field, only
 * whatever's in that collection's `PAYLOAD_DATASOURCE_COLLECTIONS` entry. */
export async function PATCH(req: Request, { params }: { params: Promise<{ collection: string; id: string }> }) {
  const { collection, id } = await params
  if (!isAllowedCollection(collection)) {
    return NextResponse.json({ error: `Collection "${collection}" is not exposed as a database source.` }, { status: 404 })
  }
  const recordId = Number(id)
  if (!Number.isFinite(recordId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  const schema = PAYLOAD_DATASOURCE_COLLECTIONS[collection]
  const body = await req.json().catch(() => null)
  const propertyId = typeof body?.propertyId === 'string' ? body.propertyId : null
  if (!propertyId || !schema.properties.some((p: PayloadPropertyDef) => p.id === propertyId)) {
    return NextResponse.json({ error: 'Unknown property.' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  const doc = await payload.update({
    collection: collection as 'pages',
    id: recordId,
    data: { [propertyId]: body.value } as never,
    overrideAccess: true,
  })
  const docRecord = doc as unknown as Record<string, unknown>

  return NextResponse.json({
    doc: { id: doc.id, fields: Object.fromEntries(schema.properties.map((p: PayloadPropertyDef) => [p.id, docRecord[p.id]])) },
  })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ collection: string; id: string }> }) {
  const { collection, id } = await params
  if (!isAllowedCollection(collection)) {
    return NextResponse.json({ error: `Collection "${collection}" is not exposed as a database source.` }, { status: 404 })
  }
  const recordId = Number(id)
  if (!Number.isFinite(recordId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  await payload.delete({ collection: collection as 'pages', id: recordId, overrideAccess: true })
  return NextResponse.json({ ok: true })
}

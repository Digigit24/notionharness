import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'

/** Resolves a single `databases` doc by id, so a mounted block can find its `fields` schema. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const recordId = Number(id)
  if (!Number.isFinite(recordId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  const doc = await payload
    .findByID({ collection: 'databases', id: recordId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!doc) {
    return NextResponse.json({ error: 'Database not found.' }, { status: 404 })
  }

  return NextResponse.json({ doc })
}

/** Updates a `databases` doc's `name` and/or `fields` schema — the whole
 * point of storing the schema as one JSON array (see `collections/Databases.ts`)
 * is that `UserDatabaseDataSource.propertyAdd`/`propertyDelete`/`propertyTypeSet`
 * all boil down to "PATCH the whole `fields` array", no separate field resource. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const recordId = Number(id)
  if (!Number.isFinite(recordId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body.' }, { status: 400 })
  }

  const data: Record<string, unknown> = {}
  if (typeof body.name === 'string') data.name = body.name
  if (Array.isArray(body.fields)) data.fields = body.fields

  const payload = await getPayloadClient()
  const doc = await payload.update({ collection: 'databases', id: recordId, data, overrideAccess: true })
  return NextResponse.json({ doc })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const recordId = Number(id)
  if (!Number.isFinite(recordId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  await payload.delete({
    collection: 'database-rows',
    where: { database: { equals: recordId } },
    overrideAccess: true,
  })
  await payload.delete({ collection: 'databases', id: recordId, overrideAccess: true })
  return NextResponse.json({ ok: true })
}

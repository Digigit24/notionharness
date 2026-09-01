import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'

/** Lists every `database-rows` doc belonging to a `databases` doc. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const databaseId = Number(id)
  if (!Number.isFinite(databaseId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'database-rows',
    where: { database: { equals: databaseId } },
    limit: 1000,
    depth: 0,
    sort: 'position',
    overrideAccess: true,
  })

  return NextResponse.json({ docs: result.docs })
}

/** Creates a new, empty row on a `databases` doc. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const databaseId = Number(id)
  if (!Number.isFinite(databaseId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  const body = await req.json().catch(() => ({}))
  const cells = body && typeof body.cells === 'object' && body.cells !== null ? body.cells : {}

  const payload = await getPayloadClient()
  const doc = await payload.create({
    collection: 'database-rows',
    data: { database: databaseId, cells },
    overrideAccess: true,
  })

  return NextResponse.json({ doc })
}

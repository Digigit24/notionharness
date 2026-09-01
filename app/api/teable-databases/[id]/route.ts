import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'

/** Resolves a single `teable-databases` connection by id, so a mounted block can find its `teableTableId`. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const recordId = Number(id)
  if (!Number.isFinite(recordId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  const doc = await payload
    .findByID({ collection: 'teable-databases', id: recordId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!doc) {
    return NextResponse.json({ error: 'Teable database connection not found.' }, { status: 404 })
  }

  return NextResponse.json({ doc })
}

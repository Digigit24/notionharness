import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'

/** Merges new cell values into a row's `cells` map (never replaces the whole
 * object — a cell edit for one property must not clobber concurrently-edited
 * cells for others). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; rowId: string }> }) {
  const { rowId } = await params
  const recordId = Number(rowId)
  if (!Number.isFinite(recordId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  const body = await req.json().catch(() => null)
  if (!body || typeof body.cells !== 'object' || body.cells === null) {
    return NextResponse.json({ error: 'cells is required.' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  const existing = await payload.findByID({ collection: 'database-rows', id: recordId, depth: 0, overrideAccess: true, disableErrors: true })
  if (!existing) {
    return NextResponse.json({ error: 'Row not found.' }, { status: 404 })
  }
  const existingCells = existing.cells && typeof existing.cells === 'object' ? existing.cells : {}
  const doc = await payload.update({
    collection: 'database-rows',
    id: recordId,
    data: { cells: { ...existingCells, ...body.cells } },
    overrideAccess: true,
  })

  return NextResponse.json({ doc })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; rowId: string }> }) {
  const { rowId } = await params
  const recordId = Number(rowId)
  if (!Number.isFinite(recordId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  await payload.delete({ collection: 'database-rows', id: recordId, overrideAccess: true })
  return NextResponse.json({ ok: true })
}

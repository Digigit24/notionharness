import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'
import { resolveTable } from '../_lib'

/**
 * Renames a Teable table (`PUT /base/{baseId}/table/{tableId}/name`) and
 * keeps the corresponding `teable-databases` connection's own `name` in
 * sync, so the "connect existing table" picker never shows a stale name.
 *
 * Uses `TEABLE_API_KEY_CREATOR` — same broader-scoped credential as
 * `create-table`, since renaming is a table-schema-level operation, not
 * day-to-day record/field CRUD (kept on the narrower `TEABLE_API_KEY`).
 */
export async function POST(req: Request) {
  const apiUrl = process.env.TEABLE_API_URL
  const apiKey = process.env.TEABLE_API_KEY_CREATOR
  if (!apiUrl || !apiKey) {
    return NextResponse.json({ error: 'Teable table renaming is not configured on the server.' }, { status: 500 })
  }

  const body = await req.json().catch(() => null)
  const teableTableId = body?.teableTableId
  const name = body?.name
  if (typeof teableTableId !== 'string' || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'Missing "teableTableId" or "name".' }, { status: 400 })
  }

  const resolved = await resolveTable(teableTableId)
  if (!resolved?.baseId) {
    return NextResponse.json({ error: 'Teable table connection not found.' }, { status: 404 })
  }

  const renameRes = await fetch(`${apiUrl.replace(/\/$/, '')}/base/${resolved.baseId}/table/${encodeURIComponent(teableTableId)}/name`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() }),
  })
  if (!renameRes.ok) {
    const errJson = await renameRes.json().catch(() => null)
    return NextResponse.json({ error: errJson?.message || `Failed to rename table (HTTP ${renameRes.status}).` }, { status: 502 })
  }

  const payload = await getPayloadClient()
  await payload.update({
    collection: 'teable-databases',
    where: { teableTableId: { equals: teableTableId } },
    data: { name: name.trim() },
    overrideAccess: true,
  })

  return NextResponse.json({ success: true })
}

import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'

/**
 * Creates a brand-new Teable table and its corresponding `teable-databases`
 * connection row. Deliberately uses `TEABLE_API_KEY_CREATOR` — a separate,
 * broader-scoped credential (`base|create`/`table|create`) kept apart from
 * the narrower `TEABLE_API_KEY` used by every other `/api/teable/*` route,
 * so the day-to-day record/field CRUD key's blast radius stays small. Never
 * sent to the client.
 */
export async function POST(req: Request) {
  const apiUrl = process.env.TEABLE_API_URL
  const apiKey = process.env.TEABLE_API_KEY_CREATOR
  const baseId = process.env.TEABLE_BASE_ID
  if (!apiUrl || !apiKey || !baseId) {
    return NextResponse.json({ error: 'Teable table creation is not configured on the server.' }, { status: 500 })
  }

  const body = await req.json().catch(() => null)
  const name = body?.name
  const workspaceId = Number(body?.workspaceId)
  if (typeof name !== 'string' || !name.trim() || !Number.isFinite(workspaceId)) {
    return NextResponse.json({ error: 'Missing "name" or "workspaceId".' }, { status: 400 })
  }

  const createRes = await fetch(`${apiUrl.replace(/\/$/, '')}/base/${baseId}/table/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name.trim(),
      fields: [{ name: 'Name', type: 'singleLineText' }],
    }),
  })
  const createJson = await createRes.json().catch(() => null)
  if (!createRes.ok) {
    return NextResponse.json(
      { error: createJson?.message || `Failed to create the Teable table (HTTP ${createRes.status}).` },
      { status: 502 },
    )
  }
  const teableTableId = createJson?.id
  if (typeof teableTableId !== 'string') {
    return NextResponse.json({ error: 'Teable did not return a table id.' }, { status: 502 })
  }

  const payload = await getPayloadClient()
  const doc = await payload.create({
    collection: 'teable-databases',
    data: {
      name: name.trim(),
      workspace: workspaceId,
      teableTableId,
      teableBaseId: baseId,
    },
    depth: 0,
    overrideAccess: true,
  })

  return NextResponse.json({ doc })
}

import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'

/** Lists `databases` docs for a workspace, for a "connect a user database" picker. */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const workspaceId = Number(searchParams.get('workspaceId'))
  if (!Number.isFinite(workspaceId)) {
    return NextResponse.json({ docs: [] })
  }

  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'databases',
    where: { workspace: { equals: workspaceId } },
    limit: 100,
    depth: 0,
    overrideAccess: true,
  })

  return NextResponse.json({ docs: result.docs })
}

/** Creates a new, empty `databases` doc (no fields yet — added via `UserDatabaseDataSource.propertyAdd`). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : 'Untitled'
  const workspaceId = Number(body?.workspaceId)
  if (!Number.isFinite(workspaceId)) {
    return NextResponse.json({ error: 'workspaceId is required.' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  const doc = await payload.create({
    collection: 'databases',
    data: { name, workspace: workspaceId, fields: [] },
    overrideAccess: true,
  })

  return NextResponse.json({ doc })
}

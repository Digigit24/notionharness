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

/**
 * Creates a new `databases` doc seeded with one default primary text field
 * (matches Teable's/Notion's own "new table" behavior) — an empty `fields`
 * array renders a table with no header row and nothing for the native
 * hover-to-expand affordance to attach to, since `getPrimaryFieldId` has
 * nothing with `isPrimary: true` to find. Further fields are still added via
 * `UserDatabaseDataSource.propertyAdd`.
 */
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
    data: {
      name,
      workspace: workspaceId,
      fields: [{ id: `field-${crypto.randomUUID()}`, name: 'Name', type: 'text', isPrimary: true }],
    },
    overrideAccess: true,
  })

  return NextResponse.json({ doc })
}

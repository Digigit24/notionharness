import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'

/** Lists `teable-databases` connections for a workspace, for the block's "connect a table" picker. */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const workspaceId = Number(searchParams.get('workspaceId'))
  if (!Number.isFinite(workspaceId)) {
    return NextResponse.json({ docs: [] })
  }

  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'teable-databases',
    where: { workspace: { equals: workspaceId } },
    limit: 100,
    depth: 0,
    overrideAccess: true,
  })

  return NextResponse.json({ docs: result.docs })
}

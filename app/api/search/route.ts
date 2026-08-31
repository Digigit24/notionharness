import { NextResponse } from 'next/server'
import type { Where } from 'payload'
import { getPayloadClient } from '@/lib/payload'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') || '').trim()
  const workspaceId = Number(searchParams.get('workspaceId'))

  if (!q) {
    return NextResponse.json({ docs: [] })
  }

  const payload = await getPayloadClient()
  const filters: Where[] = [
    { isArchived: { equals: false } },
    { or: [{ title: { like: q } }, { plainTextContent: { like: q } }] },
  ]
  if (Number.isFinite(workspaceId) && searchParams.get('workspaceId')) {
    filters.push({ workspace: { equals: workspaceId } })
  }

  const result = await payload.find({
    collection: 'pages',
    where: { and: filters },
    limit: 50,
    overrideAccess: true,
  })

  return NextResponse.json({ docs: result.docs })
}

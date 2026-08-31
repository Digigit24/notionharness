import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'
import { applyDocSync } from '@/lib/blocksuite-doc'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const pageId = Number(id)
  if (!Number.isFinite(pageId)) {
    return NextResponse.json({ error: 'Invalid page id' }, { status: 400 })
  }

  const body = await req.json().catch(() => null)
  const update = body?.update
  if (typeof update !== 'string' || !update) {
    return NextResponse.json({ error: 'Missing "update" (base64-encoded Yjs update)' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  const existing = await payload
    .findByID({ collection: 'pages', id: pageId, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!existing) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 })
  }

  await applyDocSync(payload, pageId, update)

  return NextResponse.json({ success: true })
}

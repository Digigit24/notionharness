import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'
import { markdownToDoc, encodeDocUpdate, extractPlainText } from '@/lib/blocksuite-doc'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const pageId = Number(id)
  if (!Number.isFinite(pageId)) {
    return NextResponse.json({ error: 'Invalid page id' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  const existing = await payload
    .findByID({ collection: 'pages', id: pageId, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!existing) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 })
  }

  const raw = await req.text()
  let markdown = raw
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.markdown === 'string') markdown = parsed.markdown
  } catch {
    // raw markdown body, not JSON
  }

  if (!markdown.trim()) {
    return NextResponse.json({ error: 'Empty markdown body' }, { status: 400 })
  }

  const { doc, title } = markdownToDoc(pageId, markdown, existing.title || 'Untitled')
  const update = encodeDocUpdate(doc)
  const plainTextContent = extractPlainText(doc)

  await payload.update({
    collection: 'pages',
    id: pageId,
    data: { title, docState: { update }, plainTextContent },
    overrideAccess: true,
  })

  return NextResponse.json({ success: true, title })
}

import { NextResponse } from 'next/server'
import { getPayloadClient } from '@/lib/payload'
import { loadDoc, docToMarkdown } from '@/lib/blocksuite-doc'

function filenameFor(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  return (slug || 'untitled') + '.md'
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const pageId = Number(id)
  if (!Number.isFinite(pageId)) {
    return NextResponse.json({ error: 'Invalid page id' }, { status: 400 })
  }

  const payload = await getPayloadClient()
  const page = await payload
    .findByID({ collection: 'pages', id: pageId, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 })
  }

  const title = page.title || 'Untitled'
  const { doc } = loadDoc(pageId, title, page.docState)
  const markdown = docToMarkdown(doc, title)

  return new NextResponse(markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filenameFor(title)}"`,
    },
  })
}

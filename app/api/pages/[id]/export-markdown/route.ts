import { NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { getPayloadClient } from '@/lib/payload'
import { loadDoc, docToMarkdown, MAX_EXPORT_ROWS, type DatabaseResolver, type TeableDatabaseSnapshot } from '@/lib/blocksuite-doc'
import { teableFetch } from '@/app/api/teable/_lib'

function filenameFor(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  return (slug || 'untitled') + '.md'
}

/**
 * Resolves a `teable-databases` Payload record to a {@link TeableDatabaseSnapshot}
 * by fetching its connected Teable table's fields and records through the same
 * shared proxy helper the app's other Teable routes use. Never throws — any
 * failure (unconfigured env, bad id, downstream error) returns `null` so the
 * export degrades gracefully to the block's placeholder instead of failing.
 */
async function buildDatabaseResolver(payload: Payload): Promise<DatabaseResolver> {
  const cache = new Map<number, TeableDatabaseSnapshot | null>()

  return async (teableDatabaseId: number): Promise<TeableDatabaseSnapshot | null> => {
    if (cache.has(teableDatabaseId)) return cache.get(teableDatabaseId)!

    const snapshot = await (async (): Promise<TeableDatabaseSnapshot | null> => {
      try {
        const connection = await payload
          .findByID({
            collection: 'teable-databases',
            id: teableDatabaseId,
            overrideAccess: true,
            disableErrors: true,
          })
          .catch(() => null)
        if (!connection) return null

        const tableId = connection.teableTableId
        if (typeof tableId !== 'string' || !tableId) return null

        const [fields, records] = await Promise.all([
          teableFetch(`/table/${encodeURIComponent(tableId)}/field`),
          teableFetch(`/table/${encodeURIComponent(tableId)}/record?take=${MAX_EXPORT_ROWS + 1}`),
        ])
        if (!fields.ok || !records.ok) return null

        const fieldsJson = (await fields.response.json()) as unknown
        const recordsJson = (await records.response.json()) as { records?: unknown } | unknown

        const fieldsArr = Array.isArray(fieldsJson) ? (fieldsJson as TeableDatabaseSnapshot['fields']) : []
        const recordsArr = Array.isArray((recordsJson as { records?: unknown })?.records)
          ? ((recordsJson as { records: unknown[] }).records as TeableDatabaseSnapshot['records'])
          : []

        const truncated = recordsArr.length > MAX_EXPORT_ROWS
        return {
          title: typeof connection.name === 'string' ? connection.name : 'Untitled table',
          fields: fieldsArr,
          records: truncated ? recordsArr.slice(0, MAX_EXPORT_ROWS) : recordsArr,
          truncated,
        }
      } catch {
        return null
      }
    })()

    cache.set(teableDatabaseId, snapshot)
    return snapshot
  }
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
  const markdown = await docToMarkdown(doc, title, await buildDatabaseResolver(payload))

  return new NextResponse(markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filenameFor(title)}"`,
    },
  })
}

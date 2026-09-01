'use client'

import { useEffect, useState } from 'react'
import { BlockSuiteEditor } from '@/components/editor/BlockSuiteEditor'

type PairedPage = {
  pageId: number
  workspaceId: number
  title: string
  docState?: unknown
}

/** Note slot for `createRecordDetail` — mounts the real, persisted BlockSuite
 * editor for the row's paired page (same find-or-create pairing route the
 * header slot uses), instead of a placeholder "click to create a doc". See
 * `RecordDetailHeader`'s comment for what `sourceType`/`sourceId` mean. */
export function RecordDetailNote({
  sourceType,
  sourceId,
  recordId,
  workspaceId,
}: {
  sourceType: 'teable' | 'userDatabase' | 'payload'
  sourceId: string
  recordId: string
  workspaceId?: number | null
}) {
  const [page, setPage] = useState<PairedPage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const qs = new URLSearchParams({ sourceType, sourceId, recordId })
    if (workspaceId != null) qs.set('workspaceId', String(workspaceId))
    fetch(`/api/pages/for-database-record?${qs}`)
      .then(async (r) => {
        const body = await r.json()
        if (!r.ok) throw new Error(body.error)
        return body as PairedPage
      })
      .then(setPage)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Unable to open record page.'))
  }, [sourceType, sourceId, recordId, workspaceId])

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
  if (!page) return <p className="text-sm text-black/40 dark:text-white/40">Loading…</p>

  return (
    <BlockSuiteEditor
      key={page.pageId}
      pageId={page.pageId}
      workspaceId={page.workspaceId}
      initialTitle={page.title}
      initialDocState={page.docState}
      locked={false}
    />
  )
}

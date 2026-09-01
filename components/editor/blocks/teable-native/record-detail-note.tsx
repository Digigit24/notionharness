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
 * header slot uses), instead of a placeholder "click to create a doc". */
export function RecordDetailNote({ teableTableId, recordId }: { teableTableId: string; recordId: string }) {
  const [page, setPage] = useState<PairedPage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/pages/for-teable-record?teableTableId=${encodeURIComponent(teableTableId)}&recordId=${encodeURIComponent(recordId)}`)
      .then(async (r) => {
        const body = await r.json()
        if (!r.ok) throw new Error(body.error)
        return body as PairedPage
      })
      .then(setPage)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Unable to open record page.'))
  }, [teableTableId, recordId])

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

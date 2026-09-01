'use client'

import { useEffect, useState } from 'react'
import { EmojiPicker } from '@/components/canvas/emoji-picker'
import { CoverPicker } from '@/components/canvas/cover-picker'
import { renamePage, setPageIcon, setPageCover } from '@/app/(app)/actions'

type PairedPage = {
  pageId: number
  workspaceId: number
  title: string
  icon: string | null
  coverImage: string | null
}

/**
 * Header slot for `createRecordDetail` (see `record-detail-panel.ts`): icon,
 * cover, and title editing for the row's paired page, reusing the same
 * pickers/Server Actions `page-canvas.tsx` uses for a regular page header.
 * Properties themselves are rendered natively by `createRecordDetail` — this
 * only owns the page-identity bits it doesn't cover.
 *
 * `sourceType`/`sourceId` identify the DataSource backend the row comes from
 * (`'userDatabase'` or `'payload'`, matching `collections/Pages.ts`'s
 * `linkedSourceType`) — a `'teable'` source (still a valid caller value, see
 * `native-database-block.ts`, even though it's not a valid pairing target)
 * simply surfaces the route's own "can't be paired" error below, same as any
 * other fetch failure.
 */
export function RecordDetailHeader({
  sourceType,
  sourceId,
  recordId,
  workspaceId,
  workspaceSlug,
  openDoc,
}: {
  sourceType: 'teable' | 'userDatabase' | 'payload'
  sourceId: string
  recordId: string
  workspaceId?: number | null
  workspaceSlug: string | null
  openDoc: (docId: string) => void
}) {
  const [page, setPage] = useState<PairedPage | null>(null)
  const [title, setTitle] = useState('')
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
      .then((body) => {
        setPage(body)
        setTitle(body.title)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Unable to open record page.'))
  }, [sourceType, sourceId, recordId, workspaceId])

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
  if (!page) return <p className="text-sm text-black/40 dark:text-white/40">Loading…</p>

  const isGradientCover = page.coverImage?.startsWith('gradient:')

  return (
    <div className="mb-2">
      {page.coverImage && (
        <div
          className={`mb-3 h-28 w-full rounded-md ${isGradientCover ? `bg-gradient-to-br ${page.coverImage.replace('gradient:', '')}` : ''}`}
          style={!isGradientCover ? { backgroundImage: `url(${page.coverImage})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
        />
      )}
      <div className="flex items-center gap-2">
        <EmojiPicker
          value={page.icon}
          onSelect={(emoji) => {
            setPage((p) => (p ? { ...p, icon: emoji } : p))
            if (workspaceSlug) void setPageIcon(page.pageId, workspaceSlug, emoji)
          }}
          onClear={() => {
            setPage((p) => (p ? { ...p, icon: null } : p))
            if (workspaceSlug) void setPageIcon(page.pageId, workspaceSlug, null)
          }}
        />
        {!page.coverImage && (
          <CoverPicker
            trigger="Add cover"
            onSelect={(v) => {
              setPage((p) => (p ? { ...p, coverImage: v } : p))
              if (workspaceSlug) void setPageCover(page.pageId, workspaceSlug, v)
            }}
          />
        )}
        <button
          type="button"
          className="ml-auto shrink-0 text-xs text-black/40 hover:text-black/60 dark:text-white/40 dark:hover:text-white/60"
          onClick={() => openDoc(String(page.pageId))}
        >
          Open full page ↗
        </button>
      </div>
      <input
        className="mt-2 w-full border-none bg-transparent text-2xl font-bold outline-none placeholder:text-black/20 dark:placeholder:text-white/20"
        value={title}
        placeholder="Untitled"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          if (title !== page.title && workspaceSlug) void renamePage(page.pageId, workspaceSlug, title)
        }}
      />
    </div>
  )
}

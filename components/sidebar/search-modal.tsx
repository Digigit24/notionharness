'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { FileText, Search, X } from 'lucide-react'
import { searchPages } from '@/lib/search'
import type { Page, Workspace } from '@/payload-types'

const DEBOUNCE_MS = 200

export function SearchModal({
  open,
  onClose,
  workspace,
}: {
  open: boolean
  onClose: () => void
  workspace: Workspace
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Page[]>([])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      searchPages(query, workspace.id).then((docs) => {
        if (!cancelled) setResults(docs)
      })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, workspace.id])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]" onClick={onClose}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-black/10 bg-white shadow-2xl dark:border-white/10 dark:bg-[#2f2f2f]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-black/5 px-3 py-2.5 dark:border-white/10">
          <Search size={15} className="shrink-0 text-black/40 dark:text-white/40" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${workspace.name}...`}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-black/30 dark:placeholder:text-white/30"
          />
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
          >
            <X size={15} />
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {query.trim() === '' && (
            <p className="px-2.5 py-3 text-sm text-black/40 dark:text-white/40">Start typing to search this workspace...</p>
          )}
          {query.trim() !== '' && results.length === 0 && (
            <p className="px-2.5 py-3 text-sm text-black/40 dark:text-white/40">No pages found</p>
          )}
          {results.map((p) => (
            <Link
              key={p.id}
              href={`/workspace/${workspace.slug}/p/${p.id}`}
              onClick={onClose}
              className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-black/[.06] dark:hover:bg-white/[.08]"
            >
              <span className="shrink-0">{p.icon || <FileText size={14} className="text-black/40 dark:text-white/40" />}</span>
              <span className="truncate">{p.title || 'Untitled'}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}

'use client'

import { useState } from 'react'
import { LayoutGrid, List as ListIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SessionListItem } from '@/lib/broker'
import { formatRelativeTime } from '@/lib/relative-time'

/**
 * The hero page's compact "Recent threads" strip.
 *
 * Redundant with the sidebar's own Sessions section
 * (`components/sidebar/sessions-section.tsx`) for LIST-VIEWING — that already
 * shows every session, filterable, always on screen — but the reference
 * design keeps a quick-glance strip on the page itself, which is a real,
 * different affordance: no sidebar hunting, no filter state, just "what was I
 * just doing." Reads `sessions` state `work-view.tsx` already holds (no new
 * fetch) and calls the existing `selectSession(id)` on click — no new
 * mutation path either.
 *
 * "Show all" is a no-op beyond visual completeness: the sidebar's Sessions
 * section already IS "all", one click away and always visible, so a second
 * button that also lists everything would just be a worse copy of it. Grid/
 * list is real but shallow — both render the same five cards, one as a
 * 1-column list and the other as a 2-column grid; a person switching between
 * five items head has nothing further to see either way, so nothing beyond
 * the layout itself was worth building.
 */
export function RecentThreads({
  sessions,
  onSelect,
}: {
  sessions: SessionListItem[]
  onSelect: (id: number) => void
}) {
  const [view, setView] = useState<'list' | 'grid'>('list')
  const recent = sessions.slice(0, 5)
  if (recent.length === 0) return null

  return (
    <div className="mt-8 w-full max-w-2xl">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium text-black/40 dark:text-white/40">Recent threads</h2>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-md border border-black/10 p-0.5 dark:border-white/15">
            <button
              type="button"
              aria-label="List view"
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
              className={cn(
                'flex size-5 items-center justify-center rounded',
                view === 'list'
                  ? 'bg-black/[.08] text-black/70 dark:bg-white/[.12] dark:text-white/70'
                  : 'text-black/35 dark:text-white/35',
              )}
            >
              <ListIcon size={11} />
            </button>
            <button
              type="button"
              aria-label="Grid view"
              aria-pressed={view === 'grid'}
              onClick={() => setView('grid')}
              className={cn(
                'flex size-5 items-center justify-center rounded',
                view === 'grid'
                  ? 'bg-black/[.08] text-black/70 dark:bg-white/[.12] dark:text-white/70'
                  : 'text-black/35 dark:text-white/35',
              )}
            >
              <LayoutGrid size={11} />
            </button>
          </div>
          {/* Deliberately a no-op beyond scrolling this strip into view — see
              this file's header for why "all sessions" already has a home. */}
          <button
            type="button"
            onClick={() => document.getElementById('work-recent-threads')?.scrollIntoView({ block: 'nearest' })}
            className="text-xs font-medium text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
          >
            Show all
          </button>
        </div>
      </div>
      <div id="work-recent-threads" className={cn(view === 'grid' ? 'grid grid-cols-2 gap-2' : 'flex flex-col gap-1.5')}>
        {recent.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            className="flex flex-col gap-0.5 rounded-lg border border-black/10 bg-white px-3 py-2 text-left transition hover:border-black/20 hover:shadow-sm dark:border-white/10 dark:bg-white/[.03] dark:hover:border-white/20"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-black/80 dark:text-white/80">
                {s.title || 'Untitled chat'}
              </span>
              <span className="shrink-0 text-[10px] text-black/35 dark:text-white/35">
                {formatRelativeTime(s.lastActivityAt)}
              </span>
            </span>
            {s.preview && (
              <span className="truncate text-xs text-black/45 dark:text-white/45">{s.preview}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

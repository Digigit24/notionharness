'use client'

import { useMemo, useState } from 'react'
import { Archive, Check, MessageSquare, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from 'lucide-react'
import type { SessionListItem } from '@/lib/broker'
import { Button } from '@/components/ui/button'
import { formatRelativeTime } from '@/lib/relative-time'

/**
 * The session history rail.
 *
 * This is the piece the roadmap called for and never had: §6.3 asks for the
 * thread "mounted three ways: a drawer tab, a full page with a session-list
 * rail, and a lane in the team view" — the rail was the missing mount. Its
 * absence is why Ask could only ever show one conversation per agent.
 *
 * Grouping is by recency band rather than by date, because the useful
 * question in a chat list is "how fresh is this", not "what was the date".
 * Pinned sessions ignore the bands entirely and sit at the top.
 */
export type Band = 'Pinned' | 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older'

export const BAND_ORDER: Band[] = ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Older']

/** Exported so R14-P0.3's channel History tab groups by the same bands as
 * Work's own rail, rather than a second recency scheme drifting from this
 * one. */
export function bandFor(session: SessionListItem, now: number): Band {
  if (session.pinned) return 'Pinned'
  const age = now - new Date(session.lastActivityAt).getTime()
  const day = 24 * 60 * 60 * 1000
  if (age < day) return 'Today'
  if (age < 2 * day) return 'Yesterday'
  if (age < 7 * day) return 'Previous 7 days'
  return 'Older'
}

export function SessionRail({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
  onRename,
  onTogglePin,
  onArchive,
  onDelete,
  busy,
}: {
  sessions: SessionListItem[]
  activeSessionId: number | null
  onSelect: (id: number) => void
  onNew: () => void
  onRename: (id: number, title: string) => void
  onTogglePin: (id: number, pinned: boolean) => void
  onArchive: (id: number) => void
  onDelete: (id: number) => void
  busy?: boolean
}) {
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  const grouped = useMemo(() => {
    const now = Date.now()
    const needle = query.trim().toLowerCase()
    const matches = needle
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(needle) ||
            (s.preview ?? '').toLowerCase().includes(needle) ||
            (s.agentName ?? '').toLowerCase().includes(needle),
        )
      : sessions
    const map = new Map<Band, SessionListItem[]>()
    for (const session of matches) {
      const band = bandFor(session, now)
      const list = map.get(band)
      if (list) list.push(session)
      else map.set(band, [session])
    }
    return BAND_ORDER.filter((band) => map.has(band)).map((band) => ({ band, items: map.get(band)! }))
  }, [sessions, query])

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-black/10 dark:border-white/10">
      <div className="shrink-0 space-y-2 p-3">
        <Button type="button" size="sm" className="w-full rounded-lg" onClick={onNew} disabled={busy}>
          <Plus size={13} />
          New chat
        </Button>
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-black/30 dark:text-white/30"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="w-full rounded-lg border border-black/10 bg-transparent py-1.5 pl-7 pr-2 text-xs outline-none placeholder:text-black/30 focus:border-black/25 dark:border-white/10 dark:placeholder:text-white/30 dark:focus:border-white/25"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {sessions.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-black/40 dark:text-white/40">
            No conversations yet.
          </p>
        )}
        {sessions.length > 0 && grouped.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-black/40 dark:text-white/40">
            Nothing matches “{query}”.
          </p>
        )}

        {grouped.map(({ band, items }) => (
          <section key={band} className="mb-2">
            <h3 className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-black/35 dark:text-white/35">
              {band}
            </h3>
            <ul className="space-y-0.5">
              {items.map((session) => {
                const active = session.id === activeSessionId
                return (
                  <li key={session.id}>
                    {editingId === session.id ? (
                      <div className="flex items-center gap-1 rounded-lg border border-black/15 px-1.5 py-1 dark:border-white/15">
                        <input
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              onRename(session.id, editDraft)
                              setEditingId(null)
                            }
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                        />
                        <button
                          type="button"
                          aria-label="Save name"
                          className="rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
                          onClick={() => {
                            onRename(session.id, editDraft)
                            setEditingId(null)
                          }}
                        >
                          <Check size={12} />
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel rename"
                          className="rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
                          onClick={() => setEditingId(null)}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <div
                        className={`group relative rounded-lg px-2 py-1.5 transition ${
                          active
                            ? 'bg-black/[0.06] dark:bg-white/[0.09]'
                            : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.05]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => onSelect(session.id)}
                          className="block w-full text-left"
                        >
                          <span className="flex items-center gap-1.5">
                            {session.isRunning ? (
                              <span
                                aria-label="Answering"
                                className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
                              />
                            ) : (
                              <MessageSquare size={11} className="shrink-0 text-black/30 dark:text-white/30" />
                            )}
                            <span className="min-w-0 flex-1 truncate text-xs font-medium">
                              {session.title || 'Untitled chat'}
                            </span>
                            {session.pinned && <Pin size={10} className="shrink-0 text-black/30 dark:text-white/30" />}
                          </span>
                          <span className="mt-0.5 block truncate pl-[18px] text-[10px] text-black/40 dark:text-white/40">
                            {session.agentName ?? 'Unknown agent'}
                            {session.projectName ? ` · ${session.projectName}` : ''}
                            {' · '}
                            {formatRelativeTime(session.lastActivityAt)}
                          </span>
                        </button>

                        {confirmDeleteId === session.id ? (
                          <span className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-md bg-white px-1 shadow-sm dark:bg-neutral-900">
                            <button
                              type="button"
                              className="px-1 text-[10px] font-medium text-destructive"
                              onClick={() => {
                                onDelete(session.id)
                                setConfirmDeleteId(null)
                              }}
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              aria-label="Cancel delete"
                              className="rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              <X size={11} />
                            </button>
                          </span>
                        ) : (
                          <span className="absolute right-1 top-1 hidden items-center gap-0.5 rounded-md bg-white/90 px-0.5 shadow-sm group-hover:flex dark:bg-neutral-900/90">
                            <button
                              type="button"
                              aria-label={session.pinned ? 'Unpin' : 'Pin'}
                              className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
                              onClick={() => onTogglePin(session.id, !session.pinned)}
                            >
                              {session.pinned ? <PinOff size={11} /> : <Pin size={11} />}
                            </button>
                            <button
                              type="button"
                              aria-label="Rename"
                              className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
                              onClick={() => {
                                setEditingId(session.id)
                                setEditDraft(session.title)
                              }}
                            >
                              <Pencil size={11} />
                            </button>
                            <button
                              type="button"
                              aria-label="Archive"
                              className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
                              onClick={() => onArchive(session.id)}
                            >
                              <Archive size={11} />
                            </button>
                            <button
                              type="button"
                              aria-label="Delete"
                              className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
                              onClick={() => setConfirmDeleteId(session.id)}
                            >
                              <Trash2 size={11} />
                            </button>
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  )
}

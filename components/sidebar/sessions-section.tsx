'use client'

/**
 * The Channels tab's Sessions section — the Work page's own session rail,
 * moved here.
 *
 * WHY HERE AND NOT A SEPARATE `SessionRail` IMPORT. `SessionRail`
 * (`components/work/session-rail.tsx`) is a 256px-wide sidebar built to sit
 * BESIDE the Work page's thread — its own search box, its own "New chat"
 * button, full-width rows. Squeezing that into this already-narrow shell
 * would either overflow it or need every one of its className props
 * rewritten, which is not "reusing" it so much as rebuilding it inside a
 * borrowed name. This is a new, compact render of the SAME data
 * (`SessionListItem[]`) and the SAME four mutations (rename/pin/archive/
 * delete via `work/actions.ts`), grouped with the exact recency bands
 * `SessionRail` uses (`bandFor`/`BAND_ORDER`, imported from it) so the two
 * surfaces never disagree about what "Today" means.
 *
 * FETCHED CLIENT-SIDE, ON MOUNT — NOT FROM THE WORKSPACE LAYOUT'S SERVER
 * PROPS. The layout this sidebar lives in renders on every page in the
 * product (D0's hottest path — see its own header comment). `listSessions`
 * is a LATERAL-joined query over up to 200 rows; paying for it on every
 * navigation, including the ones nobody opens this tab on, is exactly the
 * cost D0 exists to refuse. Fetching only once this component actually
 * mounts (i.e. the Channels tab is open) matches how `channel-history-tab.tsx`
 * and `canvas-pane.tsx` already handle "real data, not always needed."
 *
 * OPTIMISTIC IN BOTH DIRECTIONS. Every mutation here paints this section's
 * own list before the server confirms, and publishes onto `lib/sessions-bus.ts`
 * so a Work page open in the same tab updates too — and the reverse: a
 * message sent or a session created FROM Work reaches this list the same
 * way, without a refetch. See that file's header comment for why a bus
 * rather than lifted state.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ChevronDown,
  ChevronRight,
  Filter,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  TriangleAlert,
  X,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/hooks/use-toast'
import type { SessionListItem } from '@/lib/broker'
import { formatRelativeTime } from '@/lib/relative-time'
import { BAND_ORDER, bandFor, type Band } from '@/components/work/session-rail'
import { publishSessionEvent, useSessionBusListener, applySessionEvent } from '@/lib/sessions-bus'
import {
  listWorkSessions,
  renameWorkSession,
  setWorkSessionPinned,
  setWorkSessionArchived,
  deleteWorkSession,
} from '@/app/(app)/workspace/[workspaceSlug]/work/actions'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type SessionFilter = { kind: 'agent' | 'project'; id: number; label: string } | null

export function SessionsSection({ workspaceId, workspaceSlug }: { workspaceId: number; workspaceSlug: string }) {
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null)
  const [open, setOpen] = useState(true)
  const [filter, setFilter] = useState<SessionFilter>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    listWorkSessions({ workspaceId })
      .then((rows) => {
        if (!cancelled) setSessions(rows)
      })
      .catch(() => {
        if (!cancelled) setSessions([])
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  useSessionBusListener((event) => {
    setSessions((current) => (current == null ? current : applySessionEvent(current, event)))
  })

  const { agentOptions, projectOptions } = useMemo(() => {
    const agents = new Map<number, string>()
    const projects = new Map<number, string>()
    for (const s of sessions ?? []) {
      if (s.agentId != null) agents.set(s.agentId, s.agentName ?? `Agent ${s.agentId}`)
      if (s.projectId != null) projects.set(s.projectId, s.projectName ?? `Project ${s.projectId}`)
    }
    return {
      agentOptions: [...agents.entries()].map(([id, label]) => ({ id, label })),
      projectOptions: [...projects.entries()].map(([id, label]) => ({ id, label })),
    }
  }, [sessions])

  const filtered = useMemo(() => {
    if (!sessions) return []
    if (!filter) return sessions
    return sessions.filter((s) => (filter.kind === 'agent' ? s.agentId === filter.id : s.projectId === filter.id))
  }, [sessions, filter])

  const attentionCount = useMemo(() => (sessions ?? []).filter((s) => s.needsAttention).length, [sessions])

  const grouped = useMemo(() => {
    const now = Date.now()
    const map = new Map<Band, SessionListItem[]>()
    for (const s of filtered) {
      const band = bandFor(s, now)
      const list = map.get(band)
      if (list) list.push(s)
      else map.set(band, [s])
    }
    return BAND_ORDER.filter((band) => map.has(band)).map((band) => ({ band, items: map.get(band)! }))
  }, [filtered])

  function patchLocal(id: number, patch: Partial<SessionListItem>) {
    setSessions((current) => (current ? current.map((s) => (s.id === id ? { ...s, ...patch } : s)) : current))
    publishSessionEvent({ type: 'patched', id, patch })
  }

  async function rename(id: number, title: string) {
    const trimmed = title.trim()
    if (!trimmed) {
      setEditingId(null)
      return
    }
    const previous = sessions?.find((s) => s.id === id)?.title
    patchLocal(id, { title: trimmed })
    setEditingId(null)
    try {
      await renameWorkSession({ sessionId: id, workspaceId, title: trimmed })
    } catch (err) {
      if (previous != null) patchLocal(id, { title: previous })
      toast({ title: 'Could not rename that chat', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  async function togglePin(id: number, pinned: boolean) {
    patchLocal(id, { pinned })
    try {
      await setWorkSessionPinned({ sessionId: id, workspaceId, pinned })
    } catch (err) {
      patchLocal(id, { pinned: !pinned })
      toast({ title: 'Could not update that', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  async function archive(id: number) {
    const row = sessions?.find((s) => s.id === id) ?? null
    setSessions((current) => (current ? current.filter((s) => s.id !== id) : current))
    publishSessionEvent({ type: 'deleted', id })
    try {
      await setWorkSessionArchived({ sessionId: id, workspaceId, archived: true })
    } catch (err) {
      if (row) {
        setSessions((current) => (current ? [row, ...current] : current))
        publishSessionEvent({ type: 'created', session: row })
      }
      toast({ title: 'Could not archive that chat', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  async function del(id: number) {
    const row = sessions?.find((s) => s.id === id) ?? null
    setSessions((current) => (current ? current.filter((s) => s.id !== id) : current))
    publishSessionEvent({ type: 'deleted', id })
    setConfirmDeleteId(null)
    try {
      await deleteWorkSession({ sessionId: id, workspaceId, workspaceSlug })
    } catch (err) {
      if (row) {
        setSessions((current) => (current ? [row, ...current] : current))
        publishSessionEvent({ type: 'created', session: row })
      }
      toast({ title: 'Could not delete that chat', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between px-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-1 text-xs font-medium text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          Sessions
          {attentionCount > 0 && (
            <span
              title={`${attentionCount} need${attentionCount === 1 ? 's' : ''} attention`}
              className="flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold text-white tabular-nums"
            >
              {attentionCount}
            </span>
          )}
        </button>

        {/* R14 — filter by project or agent, over the list already fetched:
            no second query, this workspace's own sessions rarely exceed a
            couple hundred rows (`listSessions`'s own cap). */}
        {(agentOptions.length > 0 || projectOptions.length > 0) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]',
                  filter
                    ? 'border-black/20 bg-black/[.05] text-black/70 dark:border-white/25 dark:bg-white/[.08] dark:text-white/70'
                    : 'border-black/10 text-black/40 hover:text-black/70 dark:border-white/15 dark:text-white/40 dark:hover:text-white/70',
                )}
                title="Filter sessions by project or agent"
              >
                <Filter size={10} />
                {filter ? filter.label : 'Filter'}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {filter && (
                <>
                  <DropdownMenuItem onClick={() => setFilter(null)}>
                    <X size={12} className="mr-1.5" />
                    Clear filter
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {projectOptions.length > 0 && (
                <>
                  <DropdownMenuLabel>Project</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={filter?.kind === 'project' ? String(filter.id) : ''}
                    onValueChange={(v) => {
                      const opt = projectOptions.find((o) => o.id === Number(v))
                      if (opt) setFilter({ kind: 'project', id: opt.id, label: opt.label })
                    }}
                  >
                    {projectOptions.map((opt) => (
                      <DropdownMenuRadioItem key={opt.id} value={String(opt.id)}>
                        {opt.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              )}
              {agentOptions.length > 0 && (
                <>
                  {projectOptions.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel>Agent</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={filter?.kind === 'agent' ? String(filter.id) : ''}
                    onValueChange={(v) => {
                      const opt = agentOptions.find((o) => o.id === Number(v))
                      if (opt) setFilter({ kind: 'agent', id: opt.id, label: opt.label })
                    }}
                  >
                    {agentOptions.map((opt) => (
                      <DropdownMenuRadioItem key={opt.id} value={String(opt.id)}>
                        {opt.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {!open ? null : sessions == null ? (
        <p className="flex items-center gap-2 px-2 py-1 text-xs text-black/40 dark:text-white/40">
          <Loader2 size={11} className="animate-spin" />
          Loading…
        </p>
      ) : filtered.length === 0 ? (
        <p className="px-2 py-1 text-xs text-black/40 dark:text-white/40">
          {filter ? 'Nothing matches that filter.' : 'No conversations yet.'}
        </p>
      ) : (
        grouped.map(({ band, items }) => (
          <div key={band} className="mb-1">
            <h3 className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black/30 dark:text-white/30">
              {band}
            </h3>
            {items.map((s) => (
              <div
                key={s.id}
                className={cn(
                  'group relative flex items-center gap-1.5 rounded-md px-2 py-1',
                  s.needsAttention
                    ? 'bg-red-500/[.06] hover:bg-red-500/[.10] dark:bg-red-400/[.08] dark:hover:bg-red-400/[.12]'
                    : 'hover:bg-black/[.04] dark:hover:bg-white/[.06]',
                )}
              >
                {editingId === s.id ? (
                  <div className="flex flex-1 items-center gap-1">
                    <input
                      autoFocus
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void rename(s.id, editDraft)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      onBlur={() => void rename(s.id, editDraft)}
                      className="min-w-0 flex-1 rounded border border-black/15 bg-transparent px-1 py-0.5 text-xs outline-none dark:border-white/20"
                    />
                  </div>
                ) : (
                  <Link
                    href={`/workspace/${workspaceSlug}/work?session=${s.id}`}
                    className="flex min-w-0 flex-1 items-center gap-1.5"
                    title={s.preview ?? s.title}
                  >
                    {s.needsAttention ? (
                      <TriangleAlert size={11} className="shrink-0 text-red-600 dark:text-red-400" />
                    ) : s.isRunning ? (
                      <span aria-label="Answering" className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
                    ) : (
                      <span className="size-1.5 shrink-0 rounded-full bg-black/15 dark:bg-white/20" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-black/70 dark:text-white/70">
                        {s.title || 'Untitled chat'}
                      </span>
                      <span className="block truncate text-[10px] text-black/35 dark:text-white/35">
                        {s.agentName ?? 'Unknown agent'} · {formatRelativeTime(s.lastActivityAt)}
                      </span>
                    </span>
                    {s.pinned && <Pin size={9} className="shrink-0 text-black/30 dark:text-white/30" />}
                  </Link>
                )}

                {editingId !== s.id && (
                  <span className="hidden shrink-0 items-center gap-0.5 rounded bg-white/90 group-hover:flex dark:bg-neutral-900/90">
                    <button
                      type="button"
                      aria-label={s.pinned ? 'Unpin' : 'Pin'}
                      onClick={() => void togglePin(s.id, !s.pinned)}
                      className="rounded p-0.5 text-black/40 hover:bg-black/[.06] hover:text-black/70 dark:text-white/40 dark:hover:bg-white/[.10] dark:hover:text-white/70"
                    >
                      {s.pinned ? <PinOff size={11} /> : <Pin size={11} />}
                    </button>
                    <button
                      type="button"
                      aria-label="Rename"
                      onClick={() => {
                        setEditingId(s.id)
                        setEditDraft(s.title)
                      }}
                      className="rounded p-0.5 text-black/40 hover:bg-black/[.06] hover:text-black/70 dark:text-white/40 dark:hover:bg-white/[.10] dark:hover:text-white/70"
                    >
                      <Pencil size={11} />
                    </button>
                    {confirmDeleteId === s.id ? (
                      <button
                        type="button"
                        onClick={() => void del(s.id)}
                        className="px-1 text-[10px] font-medium text-destructive"
                      >
                        Delete
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label="Archive"
                        onClick={() => void archive(s.id)}
                        className="rounded p-0.5 text-black/40 hover:bg-black/[.06] hover:text-black/70 dark:text-white/40 dark:hover:bg-white/[.10] dark:hover:text-white/70"
                      >
                        <X size={11} />
                      </button>
                    )}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  )
}

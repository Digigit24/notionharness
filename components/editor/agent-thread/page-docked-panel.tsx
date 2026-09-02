'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, PanelRightClose, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConnectionStatusBanner, Thread, useThreadData } from '@/components/hermes'
import { enqueuePageRun, getPageRunSnapshots } from '@/app/(app)/actions'
import { registerPagePanelOpener } from './registry'

const STORAGE_PREFIX = 'notionforge:page-panel:'
/** Keeps a whole-page context injection from blowing past
 * `enqueuePageRun`'s own 20,000-character prompt cap once the user's own
 * text is added on top. */
const MAX_PAGE_CONTEXT_CHARS = 6000

interface PanelState {
  collapsed: boolean
  activeRunId: number | null
}

const DEFAULT_STATE: PanelState = { collapsed: true, activeRunId: null }

/** ROADMAP B-3 "Surface" — per-page persistence for "is the panel open, and
 * which run is it showing." `lib/keyboard/sidebar-collapse-store.ts` (a
 * module-singleton external store) is the established pattern for UI state
 * that must be reachable from outside the mounting component's own React
 * tree — but that need is already met here by `registry.ts`'s
 * `registerPagePanelOpener`, which exists specifically to cross the
 * BlockSuite/Lit boundary the toolbar trigger lives on. Once that's covered
 * separately, collapsed/activeRunId are ordinary state fully owned by this
 * one component instance (freshly mounted per page via `key={page.id}` in
 * `page-canvas.tsx`, exactly like `BlockSuiteEditor`) — so plain
 * `localStorage` keyed by page id, read once at mount and written on every
 * change, is simpler and equally correct here; a second external store would
 * just be state nothing outside this component ever needs to read. */
function loadPanelState(pageId: number): PanelState {
  if (typeof window === 'undefined') return DEFAULT_STATE
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${pageId}`)
    if (!raw) return DEFAULT_STATE
    const parsed = JSON.parse(raw) as Partial<PanelState>
    return {
      collapsed: typeof parsed.collapsed === 'boolean' ? parsed.collapsed : DEFAULT_STATE.collapsed,
      activeRunId: typeof parsed.activeRunId === 'number' ? parsed.activeRunId : null,
    }
  } catch {
    return DEFAULT_STATE
  }
}

interface MentionableAgent {
  id: number
  name: string
  model: string | null
}

export function PageDockedPanel({
  pageId,
  workspaceId,
  pageTitle,
  pageContent,
}: {
  pageId: number
  workspaceId: number
  pageTitle: string
  /** `page.plainTextContent` — the whole-page fallback context used when the
   * composer has nothing more specific (a selection excerpt) attached. */
  pageContent: string | null
}) {
  const [state, setState] = useState<PanelState>(() => loadPanelState(pageId))
  const [prompt, setPrompt] = useState('')
  const [attachedExcerpt, setAttachedExcerpt] = useState<string | null>(null)
  const [agents, setAgents] = useState<MentionableAgent[]>([])
  const [agentId, setAgentId] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const persist = useCallback(
    (updater: (prev: PanelState) => PanelState) => {
      setState((prev) => {
        const next = updater(prev)
        if (typeof window !== 'undefined') {
          try {
            window.localStorage.setItem(`${STORAGE_PREFIX}${pageId}`, JSON.stringify(next))
          } catch {
            // Best-effort persistence — a full/blocked localStorage must not break the panel.
          }
        }
        return next
      })
    },
    [pageId],
  )

  const setCollapsed = useCallback((collapsed: boolean) => persist((prev) => ({ ...prev, collapsed })), [persist])
  const setActiveRunId = useCallback(
    (activeRunId: number | null) => persist((prev) => ({ ...prev, activeRunId })),
    [persist],
  )

  // ROADMAP B-3 — the selection-gated toolbar trigger (`toolbar-trigger.ts` /
  // `block-anchored-thread.tsx`) is now a shortcut into this same panel: it
  // expands the panel and hands over the selected text as pre-attached
  // context, instead of forking off a separate popover/run flow.
  useEffect(() => {
    registerPagePanelOpener((excerpt) => {
      setAttachedExcerpt(excerpt)
      setCollapsed(false)
    })
    return () => registerPagePanelOpener(null)
  }, [setCollapsed])

  useEffect(() => {
    let cancelled = false
    fetch(`/api/agents?workspaceId=${workspaceId}`)
      .then((res) => (res.ok ? res.json() : { agents: [] }))
      .then((body: { agents: MentionableAgent[] }) => {
        if (cancelled) return
        setAgents(body.agents ?? [])
        setAgentId((current) => current ?? body.agents?.[0]?.id ?? null)
      })
      .catch(() => {
        // Composer surfaces "no agent" via the disabled Send button below —
        // nothing to recover here, a later manual retry re-runs this effect
        // only if the panel remounts (page navigation), which is acceptable.
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  // Only poll/stream while the panel is actually visible — same "don't pay
  // for work nobody can see" rule `useRunEventStream`'s own `observed` flag
  // exists for elsewhere in this hierarchy.
  const loader = useCallback((id: number) => getPageRunSnapshots(id), [])
  const { threads, connectionStatus, retry } = useThreadData(pageId, !state.collapsed, loader)

  const selected = useMemo(() => {
    if (state.activeRunId != null) {
      const found = threads.find((t) => t.runId === String(state.activeRunId))
      if (found) return found
    }
    return threads[0] ?? null // `useThreadData`/`useRunEventStream` sort newest-first.
  }, [threads, state.activeRunId])

  async function handleSend() {
    const text = prompt.trim()
    if (!text || !agentId || sending) return

    const context = attachedExcerpt
      ? `\n\n---\nSelected context:\n${attachedExcerpt}`
      : pageContent
        ? `\n\n---\nPage context ("${pageTitle}"):\n${pageContent.slice(0, MAX_PAGE_CONTEXT_CHARS)}`
        : ''

    setSending(true)
    setError(null)
    try {
      const { runId } = await enqueuePageRun(`${text}${context}`, pageId, agentId)
      setActiveRunId(runId)
      setPrompt('')
      setAttachedExcerpt(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start a run.')
    } finally {
      setSending(false)
    }
  }

  if (state.collapsed) {
    return (
      <div className="flex h-full shrink-0 items-start border-l border-black/5 bg-white dark:border-white/10 dark:bg-[#191919]">
        {/* ROADMAP B-3 — the "persistent, discoverable entry point" the plan
            calls for: always visible (not hover-gated, not buried in an
            overflow menu), opens the panel with the whole page as context. */}
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Ask agent about this page"
          title="Ask agent about this page"
          className="flex h-11 w-9 items-center justify-center text-black/50 hover:bg-black/[.06] hover:text-black/80 dark:text-white/50 dark:hover:bg-white/[.08] dark:hover:text-white/80"
        >
          <Bot size={16} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full w-[360px] shrink-0 flex-col border-l border-black/5 bg-white dark:border-white/10 dark:bg-[#191919]">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-black/5 px-3 dark:border-white/10">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <Bot size={14} className="shrink-0 text-black/50 dark:text-white/50" />
          <span className="truncate">Ask agent</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {threads.length > 1 && (
            <Select
              value={selected ? selected.runId : undefined}
              onValueChange={(value) => setActiveRunId(Number(value))}
            >
              <SelectTrigger size="sm" className="h-7 text-xs">
                <SelectValue placeholder="Run" />
              </SelectTrigger>
              <SelectContent>
                {threads.map((t) => (
                  <SelectItem key={t.runId} value={t.runId}>
                    Run #{t.runId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse panel"
            title="Collapse panel"
            className="flex h-7 w-7 items-center justify-center rounded-md text-black/50 hover:bg-black/[.06] hover:text-black/80 dark:text-white/50 dark:hover:bg-white/[.08] dark:hover:text-white/80"
          >
            <PanelRightClose size={15} />
          </button>
        </div>
      </div>

      <ConnectionStatusBanner status={connectionStatus} onRetry={retry} />

      <div className="min-h-0 flex-1 overflow-hidden">
        {selected ? (
          <Thread thread={selected} showUsage={false} showRunId={false} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
            <p className="text-sm text-black/40 dark:text-white/40">No conversation yet on this page.</p>
            <p className="text-xs text-black/30 dark:text-white/30">
              Ask below — the whole page is included as context by default.
            </p>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-black/5 p-2.5 dark:border-white/10">
        {attachedExcerpt && (
          <div className="mb-2 flex items-start justify-between gap-2 rounded-md bg-black/[.04] px-2 py-1.5 text-xs dark:bg-white/[.06]">
            <span className="line-clamp-2 text-black/60 dark:text-white/60">{attachedExcerpt}</span>
            <button
              type="button"
              onClick={() => setAttachedExcerpt(null)}
              aria-label="Remove attached selection"
              className="shrink-0 text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
            >
              <X size={12} />
            </button>
          </div>
        )}

        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void handleSend()
            }
          }}
          placeholder={attachedExcerpt ? 'Ask about the selection…' : 'Ask about this page…'}
          autoResize
          className="max-h-40 min-h-16 text-sm"
          disabled={sending}
        />

        <div className="mt-2 flex items-center justify-between gap-2">
          {agents.length > 1 ? (
            <Select value={agentId != null ? String(agentId) : undefined} onValueChange={(v) => setAgentId(Number(v))}>
              <SelectTrigger size="sm" className="h-7 text-xs">
                <SelectValue placeholder="Agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.model ? `${a.name} (${a.model})` : a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="truncate text-xs text-black/40 dark:text-white/40">
              {agents[0]?.name ?? (agents.length === 0 ? 'No agent configured' : '')}
            </span>
          )}

          <Button
            size="sm"
            onClick={() => void handleSend()}
            disabled={sending || !prompt.trim() || !agentId}
            data-icon="inline-end"
          >
            {sending ? 'Sending…' : 'Send'}
            <Send size={13} />
          </Button>
        </div>

        {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
      </div>
    </div>
  )
}

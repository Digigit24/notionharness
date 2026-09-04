'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, Loader2, Maximize2, Send, Square } from 'lucide-react'
import { Thread } from '@/components/hermes/Thread'
import { useRunEventStream } from '@/components/runs/use-run-event-stream'
import { adaptRunSnapshotsToThread, type ChatMessage, type ChatThread } from '@/lib/hermes/runEvent-adapter'
import {
  createWorkSession,
  getSessionSnapshots,
  sendSessionMessage,
  stopSessionRun,
} from '@/app/(app)/workspace/[workspaceSlug]/work/actions'

/**
 * An agent conversation rendered inside a page.
 *
 * Deliberately the same `Thread` component the Work page uses, not a fork.
 * Everything already built for the chat — streaming text, tool cards,
 * terminal output with exit codes, coloured diffs, permission prompts — is
 * therefore available on a page for free, which is the entire reason this
 * block is cheap to build and expensive to fake.
 *
 * The session is created lazily on the first message, so an `@` mention that
 * someone types and deletes never leaves an empty conversation behind. Once
 * created, the id is written back into the block, so the page owns this
 * conversation permanently.
 */
export function AgentSessionBlockView({
  workspaceId,
  workspaceSlug,
  sessionId,
  agentId,
  collapsed,
  onSessionCreated,
  onCollapsedChange,
}: {
  workspaceId: number
  workspaceSlug: string
  sessionId: number | null
  agentId: number | null
  collapsed: boolean
  onSessionCreated: (sessionId: number) => void
  onCollapsedChange: (collapsed: boolean) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingSend, setPendingSend] = useState<string | null>(null)
  const [agentName, setAgentName] = useState<string | null>(null)

  const loader = useCallback(
    async (id: number) => getSessionSnapshots(id, workspaceId),
    [workspaceId],
  )
  const { snapshots, retry } = useRunEventStream(sessionId ?? 0, sessionId != null, loader)

  const thread = useMemo(
    () => (snapshots.length > 0 ? adaptRunSnapshotsToThread(snapshots) : null),
    [snapshots],
  )
  const isAnswering = thread?.isRunning === true
  const activeRunId = isAnswering && thread ? Number(thread.runId) : null

  useEffect(() => {
    if (!pendingSend) return
    const landed = thread?.messages.some(
      (m) => m.role === 'user' && m.content.some((c) => c.type === 'text' && c.text.trim() === pendingSend),
    )
    if (landed) setPendingSend(null)
  }, [thread, pendingSend])

  // Only for the header label. A failure here must not stop the conversation
  // working, so it degrades to "Agent" rather than to an error.
  useEffect(() => {
    if (agentId == null) return
    let cancelled = false
    fetch(`/api/agents?workspaceId=${workspaceId}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: { agents?: Array<{ id: number; name: string }> } | null) => {
        if (cancelled || !payload?.agents) return
        setAgentName(payload.agents.find((a) => a.id === agentId)?.name ?? null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [agentId, workspaceId])

  const threadToRender = useMemo<ChatThread | null>(() => {
    if (!pendingSend) return thread
    const optimistic: ChatMessage = {
      id: 'optimistic-send',
      role: 'user',
      createdAt: new Date(),
      content: [{ type: 'text', text: pendingSend }],
      delivery: 'sending',
    }
    if (!thread) return { runId: '', messages: [optimistic], usage: [], isRunning: true }
    return { ...thread, messages: [...thread.messages, optimistic], isRunning: true }
  }, [thread, pendingSend])

  async function handleSend() {
    const text = prompt.trim()
    if (!text || sending) return
    if (agentId == null) {
      setError('This block is not bound to an agent.')
      return
    }
    setSending(true)
    setError(null)
    setPendingSend(text)
    setPrompt('')
    try {
      let id = sessionId
      if (!id) {
        const created = await createWorkSession({ workspaceId, agentId })
        id = created.id
        onSessionCreated(id)
      }
      await sendSessionMessage({ sessionId: id, workspaceId, workspaceSlug, prompt: text })
      retry()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that message.')
      setPendingSend(null)
      setPrompt((current) => (current.trim() ? current : text))
    } finally {
      setSending(false)
    }
  }

  async function handleStop() {
    if (activeRunId == null || stopping) return
    setStopping(true)
    try {
      await stopSessionRun(activeRunId)
      retry()
    } finally {
      setStopping(false)
    }
  }

  const label = agentName ?? 'Agent'

  return (
    <div className="my-1 rounded-xl border border-black/10 bg-white/60 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="flex items-center gap-1.5 border-b border-black/[0.06] px-2.5 py-1.5 dark:border-white/[0.08]">
        <button
          type="button"
          aria-label={collapsed ? 'Expand conversation' : 'Collapse conversation'}
          onClick={() => onCollapsedChange(!collapsed)}
          className="rounded p-0.5 text-black/40 hover:bg-black/5 dark:text-white/40 dark:hover:bg-white/10"
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <Bot size={13} className="shrink-0 text-black/40 dark:text-white/40" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
        {isAnswering && (
          <span className="flex shrink-0 items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
            answering
          </span>
        )}
        {sessionId != null && (
          <a
            href={`/workspace/${workspaceSlug}/work?session=${sessionId}`}
            aria-label="Open full conversation"
            title="Open in Work"
            className="rounded p-1 text-black/40 hover:bg-black/5 dark:text-white/40 dark:hover:bg-white/10"
          >
            <Maximize2 size={12} />
          </a>
        )}
      </div>

      {!collapsed && (
        <>
          {error && <p className="px-2.5 pt-2 text-[11px] text-destructive">{error}</p>}

          {threadToRender ? (
            // Bounded height: a conversation inside a document must not push
            // the rest of the page off screen. It scrolls in place, and the
            // expand control opens the same session full-screen.
            <div className="max-h-[420px] overflow-hidden px-1">
              <Thread thread={threadToRender} showUsage={false} showRunId={false} />
            </div>
          ) : (
            <p className="px-2.5 py-3 text-[11px] text-black/40 dark:text-white/40">
              Ask {label} something. The conversation stays on this page.
            </p>
          )}

          <div className="flex items-end gap-1.5 border-t border-black/[0.06] px-2 py-1.5 dark:border-white/[0.08]">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
              rows={1}
              placeholder={isAnswering ? 'Answering…' : `Message ${label}…`}
              disabled={sending || isAnswering}
              className="max-h-28 min-h-7 flex-1 resize-none bg-transparent px-1 py-1 text-xs outline-none placeholder:text-black/30 dark:placeholder:text-white/30"
            />
            {isAnswering ? (
              <button
                type="button"
                onClick={() => void handleStop()}
                disabled={stopping}
                className="shrink-0 rounded-md border border-black/10 px-2 py-1 text-[11px] hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10"
              >
                <Square size={11} className="inline" /> Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={sending || !prompt.trim()}
                className="shrink-0 rounded-md bg-primary px-2 py-1 text-[11px] text-primary-foreground disabled:opacity-40"
              >
                {sending ? <Loader2 size={11} className="inline animate-spin" /> : <Send size={11} className="inline" />}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

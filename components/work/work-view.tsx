'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bot, FolderGit2, GitBranch, Loader2, RotateCcw, Send, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EmptyState } from '@/components/ui/empty-state'
import { Thread } from '@/components/thread/Thread'
import { ConnectionStatusBanner } from '@/components/thread/connection-status-banner'
import { useRunEventStream } from '@/components/runs/use-run-event-stream'
import { adaptRunSnapshotsToThread, type ChatMessage, type ChatThread } from '@/lib/hermes/runEvent-adapter'
import type { SessionListItem } from '@/lib/broker'
import type { ActiveModelConfig } from '@/lib/runtimes/hermes/providers'
import { SessionRail } from './session-rail'
import {
  convertReplyToPage,
  createWorkSession,
  listProjectWorktreeOptions,
  setWorkSessionWorktree,
  deleteWorkSession,
  getSessionSnapshots,
  listWorkSessions,
  renameWorkSession,
  sendSessionMessage,
  setWorkSessionArchived,
  setWorkSessionPinned,
  stopSessionRun,
} from '@/app/(app)/workspace/[workspaceSlug]/work/actions'

export interface WorkAgent {
  id: number
  name: string
  profile: string
  model: ActiveModelConfig | null
}

export interface WorkProject {
  id: number
  name: string
}

/**
 * Work — the full-screen chat, with real conversations.
 *
 * What changed relative to Ask, which this replaces: a conversation is now a
 * `chat_sessions` row rather than "every standalone run for this agent", so
 * there can be many, they can be named, and the one you were last in reopens
 * on return. Continuity is Hermes's own (the dispatcher shards its `state.db`
 * per session), so nothing is replayed into the prompt any more.
 *
 * The composer carries the two bindings a message needs: which agent answers,
 * and which project it works inside.
 */
/** Mirrors `deriveTitle` in the Work server actions so the rail shows the
 * same name the server is about to store, instead of "Untitled chat" for the
 * second or two before the refresh lands. */
function deriveOptimisticTitle(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim()) ?? text
  const clean = firstLine.trim().replace(/\s+/g, ' ')
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean
}

export function WorkView({
  workspaceId,
  workspaceSlug,
  agents,
  projects,
  initialSessions,
  initialSessionId,
}: {
  workspaceId: number
  workspaceSlug: string
  agents: WorkAgent[]
  projects: WorkProject[]
  initialSessions: SessionListItem[]
  initialSessionId: number | null
}) {
  const router = useRouter()
  const [sessions, setSessions] = useState(initialSessions)
  const [activeSessionId, setActiveSessionId] = useState<number | null>(initialSessionId)
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingSend, setPendingSend] = useState<string | null>(null)
  const [failedSend, setFailedSend] = useState<string | null>(null)
  const [railBusy, setRailBusy] = useState(false)
  const [worktrees, setWorktrees] = useState<Array<{ id: number; label: string; branch: string; path: string }>>([])

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null
  // For a brand-new chat with no session yet, the pickers still need values;
  // fall back to the first agent so "New chat → type → send" works with no
  // extra clicks.
  const [draftAgentId, setDraftAgentId] = useState<number | null>(agents[0]?.id ?? null)
  const [draftProjectId, setDraftProjectId] = useState<number | null>(null)

  const agentId = activeSession?.agentId ?? draftAgentId
  const projectId = activeSession?.projectId ?? draftProjectId
  const selectedAgent = agents.find((a) => a.id === agentId) ?? null

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listWorkSessions({ workspaceId }))
    } catch {
      // A failed rail refresh must never take the thread down with it.
    }
  }, [workspaceId])

  // The server re-renders this page whenever an action revalidates it, which
  // hands down a fresh `initialSessions`. Without adopting it, the rail keeps
  // whatever the first render had — the reason a brand-new chat stayed
  // invisible in the list until a manual reload.
  useEffect(() => {
    setSessions(initialSessions)
  }, [initialSessions])

  // The worktree list follows the project: binding a session to a checkout
  // from a different project would run its turns somewhere unrelated.
  useEffect(() => {
    if (projectId == null) {
      setWorktrees([])
      return
    }
    let cancelled = false
    listProjectWorktreeOptions(projectId)
      .then((rows) => {
        if (!cancelled) setWorktrees(rows)
      })
      .catch(() => {
        if (!cancelled) setWorktrees([])
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const loader = useCallback(
    async (id: number) => getSessionSnapshots(id, workspaceId),
    [workspaceId],
  )
  const { snapshots, connectionStatus, connectionAttempt, maxConnectionAttempts, retry } = useRunEventStream(
    activeSessionId ?? 0,
    activeSessionId != null,
    loader,
  )

  const thread = useMemo(
    () => (snapshots.length > 0 ? adaptRunSnapshotsToThread(snapshots) : null),
    [snapshots],
  )
  const isAnswering = thread?.isRunning === true
  const activeRunId = isAnswering && thread ? Number(thread.runId) : null

  // Drop the optimistic bubble as soon as the real one arrives.
  useEffect(() => {
    if (!pendingSend) return
    const landed = thread?.messages.some(
      (m) => m.role === 'user' && m.content.some((c) => c.type === 'text' && c.text.trim() === pendingSend),
    )
    if (landed) setPendingSend(null)
  }, [thread, pendingSend])

  // Keep the rail's "answering" dots and ordering honest while a turn runs.
  useEffect(() => {
    if (!isAnswering) {
      void refreshSessions()
      return
    }
    const timer = setInterval(() => void refreshSessions(), 5_000)
    return () => clearInterval(timer)
  }, [isAnswering, refreshSessions])

  // The message the user just typed, painted before the server has confirmed
  // it. `pendingSend` is set synchronously in `handleSend` — before any
  // await — so the bubble appears on the same frame as the Enter keypress,
  // and the "Sending…" line under it is what distinguishes painted from
  // delivered. A failed send keeps the bubble and marks it "Not sent".
  const threadToRender = useMemo<ChatThread | null>(() => {
    const optimisticText = pendingSend ?? failedSend
    if (!optimisticText) return thread
    const optimistic: ChatMessage = {
      id: 'optimistic-send',
      role: 'user',
      createdAt: new Date(),
      content: [{ type: 'text', text: optimisticText }],
      delivery: pendingSend ? 'sending' : 'failed',
    }
    const running = pendingSend != null
    if (!thread) return { runId: '', messages: [optimistic], usage: [], isRunning: running }
    return { ...thread, messages: [...thread.messages, optimistic], isRunning: running || thread.isRunning }
  }, [thread, pendingSend, failedSend])

  function selectSession(id: number | null) {
    setActiveSessionId(id)
    setPendingSend(null)
    setFailedSend(null)
    setError(null)
    const url = id ? `/workspace/${workspaceSlug}/work?session=${id}` : `/workspace/${workspaceSlug}/work`
    // `replace` rather than `push`: switching chats is navigation within one
    // view, and stacking every switch in history makes Back useless.
    router.replace(url, { scroll: false })
  }

  async function handleSend(override?: string) {
    const text = (override ?? prompt).trim()
    if (!text || sending) return
    if (!agentId) {
      setError('Pick an agent first.')
      return
    }
    setSending(true)
    setError(null)
    setFailedSend(null)
    setPendingSend(text)
    if (!override) setPrompt('')
    try {
      // A chat with no session yet gets one on its first message, so "New
      // chat" never writes an empty row someone has to clean up later.
      let sessionId = activeSessionId
      if (!sessionId) {
        const created = await createWorkSession({ workspaceId, agentId, projectId })
        sessionId = created.id
        // Put it in the rail immediately rather than waiting for the refresh
        // that follows the send — otherwise the list stays empty while the
        // conversation it describes is already on screen.
        setSessions((current) => [
          {
            ...created,
            title: deriveOptimisticTitle(text),
            agentName: agents.find((a) => a.id === agentId)?.name ?? null,
            projectName: projects.find((p) => p.id === projectId)?.name ?? null,
            runCount: 0,
            isRunning: true,
            preview: text,
          },
          ...current,
        ])
        // State only — deliberately NO `router.replace` here. Navigating while
        // a Server Action is in flight drops that action's response: observed
        // live, the message was created, the send never resolved, and the
        // composer sat on its spinner forever with no error. The URL is
        // updated after the round-trip instead, below.
        setActiveSessionId(sessionId)
      }
      await sendSessionMessage({
        sessionId,
        workspaceId,
        workspaceSlug,
        prompt: text,
        projectId,
      })
      if (sessionId !== activeSessionId) {
        router.replace(`/workspace/${workspaceSlug}/work?session=${sessionId}`, { scroll: false })
      }
      retry()
      void refreshSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that message.')
      setPendingSend(null)
      // The bubble stays on screen marked "Not sent", and the banner above
      // offers Retry, so the text is not lost. Deliberately NOT restored into
      // the composer as well — that showed the same message twice, once in a
      // bubble and once in the box the user had just cleared.
      setFailedSend(text)
    } finally {
      setSending(false)
    }
  }

  /** Promotes one assistant reply into a page, then navigates to it. */
  async function handleConvertToPage(message: ChatMessage) {
    if (!activeSessionId) return
    setError(null)
    try {
      // First line of the reply becomes the title — the same derivation the
      // session title uses, so a page and the chat that produced it read
      // consistently.
      const firstText = message.content.find((c) => c.type === 'text')
      const title = firstText && firstText.type === 'text' ? deriveOptimisticTitle(firstText.text) : ''
      const { pageId } = await convertReplyToPage({
        sessionId: activeSessionId,
        workspaceId,
        workspaceSlug,
        content: message.content,
        title,
      })
      router.push(`/workspace/${workspaceSlug}/p/${pageId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn that reply into a page.')
    }
  }

  async function handleStop() {
    if (activeRunId == null || stopping) return
    setStopping(true)
    try {
      await stopSessionRun(activeRunId)
      retry()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop the run.')
    } finally {
      setStopping(false)
    }
  }

  const withRailBusy = async (work: () => Promise<unknown>) => {
    setRailBusy(true)
    try {
      await work()
      await refreshSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That change did not go through.')
    } finally {
      setRailBusy(false)
    }
  }

  if (agents.length === 0) {
    return (
      <main className="flex h-full w-full items-center justify-center px-5 py-8">
        <EmptyState
          icon={<Bot />}
          title="No agents yet"
          description="Create an agent before starting a conversation."
        />
      </main>
    )
  }

  return (
    <div className="flex h-full w-full">
      <SessionRail
        sessions={sessions}
        activeSessionId={activeSessionId}
        busy={railBusy}
        onSelect={(id) => selectSession(id)}
        onNew={() => {
          setDraftAgentId(activeSession?.agentId ?? agents[0]?.id ?? null)
          setDraftProjectId(activeSession?.projectId ?? null)
          selectSession(null)
        }}
        onRename={(id, title) => void withRailBusy(() => renameWorkSession({ sessionId: id, workspaceId, title }))}
        onTogglePin={(id, pinned) =>
          void withRailBusy(() => setWorkSessionPinned({ sessionId: id, workspaceId, pinned }))
        }
        onArchive={(id) =>
          void withRailBusy(async () => {
            await setWorkSessionArchived({ sessionId: id, workspaceId, archived: true })
            if (id === activeSessionId) selectSession(null)
          })
        }
        onDelete={(id) =>
          void withRailBusy(async () => {
            await deleteWorkSession({ sessionId: id, workspaceId, workspaceSlug })
            if (id === activeSessionId) selectSession(null)
          })
        }
      />

      <div className="flex min-w-0 flex-1 flex-col px-5 py-4">
        <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">
              {activeSession?.title || (activeSessionId ? 'Untitled chat' : 'New chat')}
            </h1>
            <p className="truncate text-xs text-black/40 dark:text-white/40">
              {selectedAgent?.model
                ? `${selectedAgent.name} · ${selectedAgent.model.provider} / ${selectedAgent.model.model}${
                    selectedAgent.profile ? ` (${selectedAgent.profile})` : ''
                  }`
                : selectedAgent
                  ? `${selectedAgent.name} · model unknown`
                  : 'Pick an agent'}
            </p>
          </div>
        </div>

        <ConnectionStatusBanner
          status={connectionStatus}
          attempt={connectionAttempt}
          maxAttempts={maxConnectionAttempts}
          onRetry={retry}
        />

        {error && (
          <div className="mb-2 flex items-start justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
            <span>{error}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>
              <X size={12} />
            </button>
          </div>
        )}

        {failedSend && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <span className="truncate">That message was not sent.</span>
            <span className="flex shrink-0 gap-1">
              <Button size="sm" variant="outline" onClick={() => void handleSend(failedSend)} disabled={sending}>
                <RotateCcw size={11} />
                Retry
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFailedSend(null)}>
                Dismiss
              </Button>
            </span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
          {threadToRender ? (
            <Thread
              thread={threadToRender}
              showUsage
              showRunId={false}
              onStop={activeRunId != null ? () => void handleStop() : undefined}
              onConvertToPage={activeSessionId != null ? (m) => void handleConvertToPage(m) : undefined}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
              <p className="text-sm text-black/50 dark:text-white/50">
                {activeSessionId ? 'No messages yet' : 'Start a new conversation'}
              </p>
              <p className="text-xs text-black/30 dark:text-white/30">
                Pick an agent and a project below, then say what you need.
              </p>
            </div>
          )}
        </div>

        <div className="mt-3 shrink-0">
          <div className="rounded-2xl border border-black/10 bg-white shadow-sm transition focus-within:border-black/20 focus-within:shadow-md dark:border-white/10 dark:bg-white/[0.03] dark:focus-within:border-white/20">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
              placeholder={isAnswering ? 'Agent is answering…' : 'Say what you need…'}
              autoResize
              className="max-h-48 min-h-14 resize-none border-0 bg-transparent px-4 py-3 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
              disabled={sending || isAnswering}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2.5">
              <div className="flex items-center gap-1.5">
                <Select
                  value={agentId != null ? String(agentId) : undefined}
                  onValueChange={(v) => setDraftAgentId(Number(v))}
                  // An existing conversation's agent is fixed: its history
                  // lives in that agent's own Hermes session, so swapping
                  // mid-thread would silently answer from a different store.
                  disabled={activeSessionId != null}
                >
                  <SelectTrigger size="sm" className="h-7 w-44 text-xs">
                    <Bot size={12} />
                    <SelectValue placeholder="Agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={projectId != null ? String(projectId) : 'none'}
                  onValueChange={(v) => setDraftProjectId(v === 'none' ? null : Number(v))}
                >
                  <SelectTrigger size="sm" className="h-7 w-44 text-xs">
                    <FolderGit2 size={12} />
                    <SelectValue placeholder="No project" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No project</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/* Only shown once a project with worktrees is chosen —
                    an empty picker teaches nothing. Binding here is what
                    makes the agent run inside that checkout. */}
                {worktrees.length > 0 && (
                  <Select
                    value={activeSession?.worktreeId != null ? String(activeSession.worktreeId) : 'none'}
                    onValueChange={(v) => {
                      if (!activeSessionId) return
                      void withRailBusy(() =>
                        setWorkSessionWorktree({
                          sessionId: activeSessionId,
                          workspaceId,
                          worktreeId: v === 'none' ? null : Number(v),
                        }),
                      )
                    }}
                    disabled={activeSessionId == null}
                  >
                    <SelectTrigger size="sm" className="h-7 w-48 text-xs">
                      <GitBranch size={12} />
                      <SelectValue placeholder="No worktree" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No worktree</SelectItem>
                      {worktrees.map((w) => (
                        <SelectItem key={w.id} value={String(w.id)}>
                          {w.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {isAnswering ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full"
                  onClick={() => void handleStop()}
                  disabled={stopping}
                >
                  <Square size={11} />
                  {stopping ? 'Stopping…' : 'Stop'}
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="rounded-full"
                  onClick={() => void handleSend()}
                  disabled={sending || !prompt.trim()}
                >
                  {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                  Send
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

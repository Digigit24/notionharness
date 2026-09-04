'use client'

import { useEffect, useMemo, useState } from 'react'
import { Bot, Send, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConnectionStatusBanner, Thread } from '@/components/thread'
import { useRunEventStream } from '@/components/runs/use-run-event-stream'
import {
  cancelAskRun,
  checkAskRunStatus,
  enqueueAskRun,
  getAskRunSnapshots,
} from '@/app/(app)/workspace/[workspaceSlug]/ask/actions'
import { EmptyState } from '@/components/ui/empty-state'
import type { ActiveModelConfig } from '@/lib/runtimes/hermes/providers'
import { adaptRunSnapshotsToThread, type ChatMessage, type ChatThread } from '@/lib/hermes/runEvent-adapter'

/** Shown only on a genuinely empty conversation — clicking one sends it. */
const STARTER_PROMPTS = [
  'Summarise this codebase and how it is structured.',
  'Run the test suite and explain any failures.',
  'What changed in the last few commits?',
]

export interface AskableAgent {
  id: number
  name: string
  /** Hermes profile the agent runs as ('' = install root). */
  profile: string
  /** Provider/model that profile's own config.yaml pins, when readable. */
  model: ActiveModelConfig | null
}

/**
 * The general-purpose "Ask" page (ROADMAP B-0's "Ask" section — previously
 * NOT LINKED, no route existed; see sidebar.tsx's own comment). A standalone
 * conversation with one agent, not tied to any page or task. Unlike the
 * other `<Thread>` chromes (drawer/full-page/lane, which each show one RUN
 * at a time via `useThreadData`), this page combines every run for the
 * selected agent into one continuous scrolling conversation via
 * `adaptRunSnapshotsToThread` — a real back-and-forth needs that, since
 * every send still creates its own separate `runs` row today (see
 * ask/actions.ts's own comment on why: no ACP session resumption exists
 * yet). See `enqueueAskRun`/`getAskRunSnapshots` and
 * `listRunsForAgentStandalone`'s own comment for exactly how "standalone" is
 * defined at the DB level.
 *
 * Switching the agent picker below changes runtime profile / permission
 * mode / instructions / skills — and, since an agent can pin a Hermes
 * profile (its own complete HERMES_HOME with its own config.yaml), which
 * model answers. The header shows the selected agent's model, read from
 * that profile's config by the page, never the agent's cosmetic `model`
 * field.
 */
export function AskView({
  workspaceId,
  agents,
}: {
  workspaceId: number
  agents: AskableAgent[]
}) {
  const [agentId, setAgentId] = useState<number | null>(agents[0]?.id ?? null)
  const selectedAgent = agents.find((a) => a.id === agentId) ?? null
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [pendingSend, setPendingSend] = useState<string | null>(null)
  // Set when a send fails. The typed text is KEPT — losing what someone wrote
  // because a server action 404'd mid-deploy is the worst possible response
  // to a failure that a single retry usually fixes.
  const [failedSend, setFailedSend] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [runNotice, setRunNotice] = useState<string | null>(null)

  const loader = async (id: number) => getAskRunSnapshots(id)
  const { snapshots, connectionStatus, connectionAttempt, maxConnectionAttempts, retry } = useRunEventStream(
    agentId ?? 0,
    agentId != null,
    loader,
  )
  const selected = useMemo(
    () => (snapshots.length > 0 ? adaptRunSnapshotsToThread(snapshots) : null),
    [snapshots],
  )
  // Only one run can be active per agent at a time (the broker's
  // `runs_task_agent_active_uidx`), so sending mid-reply used to fail with a
  // raw Postgres constraint error surfaced as an unhandled server-render
  // crash. Reflect that state in the composer instead of letting someone
  // click into a guaranteed failure.
  const agentIsAnswering = selected?.isRunning === true
  const activeRunId = agentIsAnswering && selected ? Number(selected.runId) : null

  // Drop the optimistic bubble the moment the real one lands, matched by text
  // so the two can't briefly show as duplicates.
  useEffect(() => {
    if (!pendingSend) return
    const landed = selected?.messages.some(
      (m) => m.role === 'user' && m.content.some((c) => c.type === 'text' && c.text.trim() === pendingSend),
    )
    if (landed) setPendingSend(null)
  }, [selected, pendingSend])

  // Paints the just-sent message locally while the server action is still in
  // flight. Purely additive — it never mutates `selected`, so the real stream
  // stays the single source of truth and simply replaces this on arrival.
  const threadToRender = useMemo<ChatThread | null>(() => {
    if (!pendingSend) return selected
    const optimistic: ChatMessage = {
      id: 'optimistic-send',
      role: 'user',
      createdAt: new Date(),
      content: [{ type: 'text', text: pendingSend }],
    }
    if (!selected) return { runId: '', messages: [optimistic], usage: [], isRunning: true }
    return { ...selected, messages: [...selected.messages, optimistic], isRunning: true }
  }, [selected, pendingSend])

  async function handleCheckStatus() {
    if (activeRunId == null || checking) return
    setChecking(true)
    setRunNotice(null)
    try {
      const result = await checkAskRunStatus(activeRunId)
      if (result.workerLost) {
        setRunNotice('Run was interrupted (worker lost). It has been released — you can send again.')
      } else if (result.status === 'running' || result.status === 'queued') {
        setRunNotice('Still running — the agent has not reported anything new yet.')
      } else {
        const firstLine = result.error ? result.error.split('\n')[0] : ''
        setRunNotice(`Run ${result.status}${firstLine ? `: ${firstLine}` : ''}`)
      }
      retry()
    } catch (err) {
      setRunNotice(err instanceof Error ? err.message : 'Could not check the run.')
    } finally {
      setChecking(false)
    }
  }

  async function handleStop() {
    if (activeRunId == null || stopping) return
    setStopping(true)
    setError(null)
    try {
      await cancelAskRun(activeRunId)
      // The agent settles the turn itself after `session/cancel` (emitting a
      // real `done`), so there's nothing to force here — just re-sync so the
      // composer flips back out of its answering state promptly.
      retry()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop the run.')
    } finally {
      setStopping(false)
    }
  }

  async function handleSend(override?: string) {
    const text = (override ?? prompt).trim()
    if (!text || !agentId || sending) return
    setSending(true)
    setError(null)
    setRunNotice(null)
    setFailedSend(null)
    // Paint the message immediately rather than after the round-trip. The
    // server action has to reach a database in another region before a run
    // even exists, and until then the composer looked like it had swallowed
    // the message. Cleared as soon as the real event arrives in `snapshots`.
    setPendingSend(text)
    // Cleared here, not after the round-trip: the optimistic bubble already
    // shows this text, so leaving it in the composer as well showed the user
    // their own message twice for the 4-6s the server action takes. Restored
    // by the catch below if the send actually fails.
    if (!override) setPrompt('')
    try {
      await enqueueAskRun({ prompt: text, workspaceId, agentId })
      // Discovery of a brand-new run otherwise waits for the next
      // 8s discovery poll (use-run-event-stream.ts's own interval) — for
      // the run the user just started themselves, that reads as "my
      // message didn't send." `retry()` forces an immediate re-discovery
      // (it also reopens existing EventSources, but those resume cheaply
      // via `?since=`/Last-Event-ID, so this isn't a meaningfully bigger
      // operation than the poll it's replacing).
      retry()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start a run.')
      // The bubble stays, tinted, with its own Retry — and the text goes back
      // in the composer so nothing typed is ever lost to a transient failure.
      setPendingSend(null)
      setFailedSend(text)
      // Put the text back exactly as typed — unless the user has already
      // started composing something else in the meantime.
      setPrompt((current) => (current.trim() ? current : text))
    } finally {
      setSending(false)
    }
  }

  if (agents.length === 0) {
    return (
      <main className="flex h-full w-full items-center justify-center px-5 py-8">
        <EmptyState
          icon={<Bot />}
          title="No agents configured yet"
          description="Create an agent (with an enabled runtime profile) to start a conversation."
        />
      </main>
    )
  }

  return (
    <div className="flex h-full w-full flex-col px-5 py-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Ask</h1>
          <p className="text-xs text-black/40 dark:text-white/40">
            {selectedAgent?.model
              ? `Answering with ${selectedAgent.model.provider} / ${selectedAgent.model.model}${selectedAgent.profile ? ` (profile: ${selectedAgent.profile})` : ''}`
              : 'Model unknown'}
          </p>
        </div>
        <Select
          value={agentId != null ? String(agentId) : undefined}
          onValueChange={(v) => setAgentId(Number(v))}
        >
          <SelectTrigger size="sm" className="w-56 text-sm">
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
      </div>

      <ConnectionStatusBanner
        status={connectionStatus}
        attempt={connectionAttempt}
        maxAttempts={maxConnectionAttempts}
        onRetry={retry}
      />

      {runNotice && (
        <div className="mb-2 rounded-md border border-black/10 bg-black/[0.02] px-3 py-1.5 text-xs text-black/60 dark:border-white/10 dark:bg-white/[0.03] dark:text-white/60">
          {runNotice}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
        {threadToRender ? (
          <Thread
            thread={threadToRender}
            showUsage={true}
            showRunId={false}
            onCheckStatus={activeRunId != null ? () => void handleCheckStatus() : undefined}
            onStop={activeRunId != null ? () => void handleStop() : undefined}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
            <div>
              <p className="text-sm text-black/50 dark:text-white/50">Start a conversation</p>
              <p className="text-xs text-black/30 dark:text-white/30">
                Ask below, or try one of these.
              </p>
            </div>
            {/* An empty pane that only says "nothing here" teaches nobody what
                this agent can actually do. These three cover the shapes it
                handles — read a codebase, run something, explain something —
                and send on click rather than only filling the box. */}
            <div className="flex flex-col items-stretch gap-1.5">
              {STARTER_PROMPTS.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => void handleSend(starter)}
                  disabled={sending || !agentId}
                  className="rounded-xl border border-black/10 px-3 py-2 text-left text-[13px] text-black/60 transition hover:border-black/20 hover:bg-black/[0.03] disabled:opacity-50 dark:border-white/10 dark:text-white/60 dark:hover:border-white/20 dark:hover:bg-white/[0.04]"
                >
                  {starter}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Composer: one rounded surface that owns the textarea and its
          actions together, rather than a bare textarea with a button
          floating beneath it. Focus-within lifts the whole card so the
          active target is unambiguous. */}
      <div className="mt-3 shrink-0">
        <div className="rounded-2xl border border-black/10 bg-white shadow-sm transition focus-within:border-black/20 focus-within:shadow-md dark:border-white/10 dark:bg-white/[0.03] dark:focus-within:border-white/20">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter makes a newline — the convention
              // every chat UI uses. Cmd/Ctrl+Enter still works for muscle
              // memory from the previous behaviour.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void handleSend()
              }
            }}
            placeholder={agentIsAnswering ? 'Agent is answering…' : 'Ask anything…'}
            autoResize
            className="max-h-48 min-h-14 resize-none border-0 bg-transparent px-4 py-3 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
            disabled={sending || agentIsAnswering}
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <span className="text-[11px] text-black/35 dark:text-white/35">
              <kbd className="rounded border border-black/10 px-1 py-0.5 font-sans dark:border-white/15">Enter</kbd> to send
              {' · '}
              <kbd className="rounded border border-black/10 px-1 py-0.5 font-sans dark:border-white/15">Shift</kbd>
              {' + '}
              <kbd className="rounded border border-black/10 px-1 py-0.5 font-sans dark:border-white/15">Enter</kbd> for a new line
            </span>
            {agentIsAnswering ? (
              <Button
                size="sm"
                variant="outline"
                className="rounded-full"
                onClick={() => void handleStop()}
                disabled={stopping}
                data-icon="inline-end"
              >
                {stopping ? 'Stopping…' : 'Stop'}
                <Square size={11} />
              </Button>
            ) : (
              <Button
                size="sm"
                className="rounded-full"
                onClick={() => void handleSend()}
                disabled={sending || !prompt.trim() || !agentId}
                data-icon="inline-end"
              >
                {sending ? 'Sending…' : 'Send'}
                <Send size={13} />
              </Button>
            )}
          </div>
        </div>
        {failedSend ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs text-destructive">
            <span className="min-w-0 flex-1 truncate">
              Failed to send{error ? ` — ${error}` : ''}
            </span>
            <button
              type="button"
              onClick={() => {
                const text = failedSend
                setFailedSend(null)
                void handleSend(text)
              }}
              className="shrink-0 font-medium underline-offset-2 hover:underline"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => {
                setFailedSend(null)
                setError(null)
              }}
              className="shrink-0 opacity-60 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        ) : (
          error && <p className="mt-1.5 text-xs text-destructive">{error}</p>
        )}
      </div>
    </div>
  )
}

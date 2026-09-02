'use client'

// ROADMAP B-1 "Detail" — the task detail page's Work tab: the task's
// BlockSuite document (lazily created via `ensureTaskPage`, same ROADMAP 6.1
// primitive the daemon's page-writes use) on top, then a single scrolling
// timeline that interleaves comments and runs by time, with one composer at
// the bottom — Enter posts a comment, ⌘/Ctrl+Enter starts a run. No
// dual-verb composer existed anywhere in this codebase to reuse (checked:
// no `createComment`/comment-composer component, no cmd-enter handler
// outside the keyboard registry's own shortcuts) — this is a new, minimal
// one, not a second copy of an existing one.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ChevronDown, ChevronRight, FileText } from 'lucide-react'
import { BlockSuiteEditor } from '@/components/editor/BlockSuiteEditor'
import { Thread } from '@/components/hermes'
import { adaptRunEventsToThread, type ChatThread } from '@/lib/hermes/runEvent-adapter'
import type { RunEventEnvelope } from '@/lib/run-events'
import { getRunMessages, getTaskRuns } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import {
  createTaskComment,
  ensureTaskDocument,
  listTaskComments,
  startTaskRun,
} from '@/app/(app)/workspace/[workspaceSlug]/tasks/[taskId]/actions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import type { Run, RunStatus } from '@/lib/broker'
import type { Agent, Comment, Page } from '@/payload-types'

const POLL_MS = 4000

const RUN_BADGE_VARIANT: Record<RunStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'default',
  failed: 'destructive',
  cancelled: 'outline',
  queued: 'secondary',
  dispatched: 'secondary',
  running: 'secondary',
  waiting_directory: 'secondary',
}

export function TaskWorkTab({
  taskId,
  workspaceId,
  workspaceSlug,
  agents,
  taskAgentId,
  page,
  initialComments,
  initialRuns,
}: {
  taskId: number
  workspaceId: number
  workspaceSlug: string
  agents: Agent[]
  taskAgentId: number | null
  page: Page | null
  initialComments: Comment[]
  initialRuns: Run[]
}) {
  const router = useRouter()
  const [comments, setComments] = useState(initialComments)
  const [runs, setRuns] = useState(initialRuns)
  const [threadsByRun, setThreadsByRun] = useState<Record<number, ChatThread>>({})
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creatingDoc, setCreatingDoc] = useState(false)

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents])

  useEffect(() => {
    let active = true
    async function refresh() {
      const [nextComments, nextRuns] = await Promise.all([listTaskComments(taskId), getTaskRuns(taskId)])
      if (active) {
        setComments(nextComments)
        setRuns(nextRuns)
      }
    }
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [taskId])

  const timeline = useMemo(() => {
    const items = [
      ...comments.map((comment) => ({
        key: `comment-${comment.id}`,
        time: new Date(comment.createdAt).getTime(),
        kind: 'comment' as const,
        comment,
      })),
      ...runs.map((run) => ({
        key: `run-${run.id}`,
        time: new Date(run.startedAt ?? run.createdAt).getTime(),
        kind: 'run' as const,
        run,
      })),
    ]
    items.sort((a, b) => a.time - b.time)
    return items
  }, [comments, runs])

  async function toggleRun(runId: number) {
    setExpandedRunId((prev) => (prev === runId ? null : runId))
    if (threadsByRun[runId]) return
    const events = await getRunMessages(runId)
    const envelopes: RunEventEnvelope[] = events.map((row) => ({ runId: String(runId), seq: row.seq, event: row.event }))
    setThreadsByRun((prev) => ({ ...prev, [runId]: adaptRunEventsToThread(envelopes) }))
  }

  async function submitComment() {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      const comment = await createTaskComment({ taskId, workspaceSlug, body: text })
      setComments((prev) => [...prev, comment])
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post comment.')
    } finally {
      setBusy(false)
    }
  }

  async function submitRun() {
    if (busy) return
    if (!taskAgentId) {
      setError('Assign an agent in the right rail before starting a run.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const run = await startTaskRun({ taskId, workspaceSlug, agentId: taskAgentId, prompt: draft.trim() || undefined })
      setRuns((prev) => [...prev, run])
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start run.')
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submitRun()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submitComment()
    }
  }

  async function handleStartDocument() {
    setCreatingDoc(true)
    try {
      await ensureTaskDocument(taskId, workspaceSlug)
      router.refresh()
    } finally {
      setCreatingDoc(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-black/10 dark:border-white/10">
        {page ? (
          <div className="h-[420px] overflow-y-auto">
            <BlockSuiteEditor
              pageId={page.id}
              workspaceId={workspaceId}
              workspaceSlug={workspaceSlug}
              initialTitle={page.title}
              initialDocState={page.docState}
              locked={false}
            />
          </div>
        ) : (
          <div className="p-6">
            <EmptyState
              icon={<FileText size={18} />}
              title="No document yet"
              description="This task has no BlockSuite document. Start one to give agents (and yourself) somewhere to write plans, findings, and summaries."
              action={{ label: creatingDoc ? 'Starting…' : 'Start document', onClick: () => void handleStartDocument() }}
            />
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {timeline.length === 0 ? (
          <p className="text-sm text-black/40 dark:text-white/40">
            No comments or runs yet. Say something or start a run below to get going.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {timeline.map((item) =>
              item.kind === 'comment' ? (
                <CommentRow key={item.key} comment={item.comment} />
              ) : (
                <RunRow
                  key={item.key}
                  run={item.run}
                  workspaceSlug={workspaceSlug}
                  agentName={item.run.agentId != null ? agentById.get(item.run.agentId) ?? null : null}
                  expanded={expandedRunId === item.run.id}
                  thread={threadsByRun[item.run.id]}
                  onToggle={() => void toggleRun(item.run.id)}
                />
              ),
            )}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-black/10 p-3 dark:border-white/10">
        {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Write a comment (Enter to post) or a prompt (⌘/Ctrl+Enter to run)…"
          className="w-full resize-none rounded-md border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-white/10 dark:focus:border-white/30"
        />
        <div className="mt-2 flex items-center justify-between">
          <p className="text-xs text-black/40 dark:text-white/40">Enter to comment · ⌘/Ctrl+Enter to start a run</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy || !draft.trim()} onClick={() => void submitComment()}>
              Comment
            </Button>
            <Button type="button" size="sm" disabled={busy || !draft.trim() || !taskAgentId} onClick={() => void submitRun()} title={!taskAgentId ? 'Assign an agent first' : undefined}>
              Start run
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CommentRow({ comment }: { comment: Comment }) {
  const author = typeof comment.author === 'object' ? comment.author : null
  return (
    <li className="rounded-md border border-black/10 p-3 text-sm dark:border-white/10">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{author?.name || author?.email || 'Someone'}</span>
        <span className="text-xs text-black/30 dark:text-white/30">{new Date(comment.createdAt).toLocaleString()}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-black/80 dark:text-white/80">{comment.body}</p>
    </li>
  )
}

function RunRow({
  run,
  workspaceSlug,
  agentName,
  expanded,
  thread,
  onToggle,
}: {
  run: Run
  workspaceSlug: string
  agentName: string | null
  expanded: boolean
  thread: ChatThread | undefined
  onToggle: () => void
}) {
  return (
    <li className="rounded-md border border-black/10 dark:border-white/10">
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-black/[.03] dark:hover:bg-white/[.04]">
        <span className="flex min-w-0 items-center gap-2">
          {expanded ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
          <Badge variant={RUN_BADGE_VARIANT[run.status]}>{run.status}</Badge>
          <span className="truncate">Run #{run.id}{agentName ? ` · ${agentName}` : ''}</span>
        </span>
        <span className="shrink-0 text-xs text-black/30 dark:text-white/30">
          {new Date(run.startedAt ?? run.createdAt).toLocaleString()}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-black/10 dark:border-white/10">
          <div className="flex items-center justify-end px-3 py-1.5">
            <Link href={`/workspace/${workspaceSlug}/runs/${run.id}/review`} className="text-xs font-medium text-foreground underline-offset-4 hover:underline">
              Open review →
            </Link>
          </div>
          <div className="h-[320px]">{thread ? <Thread thread={thread} showUsage showRunId={false} /> : <p className="p-4 text-sm text-black/40 dark:text-white/40">Loading transcript…</p>}</div>
        </div>
      )}
    </li>
  )
}

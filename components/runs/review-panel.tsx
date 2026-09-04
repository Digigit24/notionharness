'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, File, FileWarning, GitBranch } from 'lucide-react'
import { approveAndMergeRun, getFileDiffAction, requestChangesOnRun } from '@/app/(app)/workspace/[workspaceSlug]/runs/[runId]/review/actions'
import { parseUnifiedDiff, type DiffLine } from '@/lib/run-worktrees/parse-unified-diff'
import type { ChangedFile, FileChangeStatus, WorktreeState } from '@/lib/run-worktrees/diff'
import type { Run, RunStatus } from '@/lib/broker'
import { DetailLayout, type DetailLayoutTab } from '@/components/layout/detail-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatTimestamp } from '@/lib/relative-time'

// ROADMAP P6.4 review surface, first pass. Inline diff mode only (not
// side-by-side) — the task brief explicitly said "don't half-build both,"
// and inline is the faster of the two to render correctly: side-by-side
// needs column-alignment logic for hunks that add/remove different line
// counts, inline just needs the unified patch as-is.
//
// ROADMAP B-0 — restructured onto `<DetailLayout>` (components/layout/
// detail-layout.tsx): header (breadcrumb/title/status badge/approve &
// merge + request-changes actions) is rendered once outside the tab area,
// a persistent right rail carries run/task/agent/worktree metadata, and
// the file-tree + diff viewer becomes the single "Diff" tab. Only one real
// tab exists today because that's genuinely all this page renders — no
// fake empty tabs were added; a "Trace"/"Activity" tab is a natural
// addition once this page's scope grows in a later batch (see the P6.4
// comment above: comment-threading was already out of scope for this
// pass, and would be a second real tab when it lands).
interface TreeNode {
  name: string
  path: string
  children: TreeNode[]
  file: ChangedFile | null
}

function buildFileTree(files: ChangedFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [], file: null }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    parts.forEach((part, idx) => {
      const isLeaf = idx === parts.length - 1
      let child = node.children.find((c) => c.name === part && (c.file !== null) === isLeaf)
      if (!child) {
        child = { name: part, path: parts.slice(0, idx + 1).join('/'), children: [], file: isLeaf ? file : null }
        node.children.push(child)
      }
      node = child
    })
  }
  const sortTree = (node: TreeNode) => {
    node.children.sort((a, b) => {
      const aIsDir = a.file === null
      const bIsDir = b.file === null
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    node.children.forEach(sortTree)
  }
  sortTree(root)
  return root.children
}

const STATUS_STYLES: Record<FileChangeStatus, string> = {
  added: 'text-green-600 dark:text-green-400',
  modified: 'text-amber-600 dark:text-amber-400',
  deleted: 'text-red-600 dark:text-red-400',
  renamed: 'text-purple-600 dark:text-purple-400',
  copied: 'text-purple-600 dark:text-purple-400',
  unknown: 'text-black/50 dark:text-white/50',
}

const STATUS_LABELS: Record<FileChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  unknown: '?',
}

const STATUS_BADGE_VARIANT: Record<RunStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'default',
  failed: 'destructive',
  cancelled: 'outline',
  queued: 'secondary',
  dispatched: 'secondary',
  running: 'secondary',
  waiting_directory: 'secondary',
}

export function ReviewPanel({
  workspaceSlug,
  run,
  taskTitle,
  agentName,
  worktreeState,
  files,
}: {
  workspaceSlug: string
  run: Run
  taskTitle: string | null
  agentName: string | null
  worktreeState: WorktreeState
  files: ChangedFile[]
}) {
  const tree = useMemo(() => buildFileTree(files), [files])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(tree.map((n) => n.path)))
  const [selected, setSelected] = useState<ChangedFile | null>(files[0] ?? null)
  const [diffCache, setDiffCache] = useState<Record<string, { patch: string; isBinary: boolean }>>({})
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requestNote, setRequestNote] = useState('')
  const [showRequestForm, setShowRequestForm] = useState(false)

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  async function selectFile(file: ChangedFile) {
    setSelected(file)
    if (diffCache[file.path]) return
    setLoadingPath(file.path)
    try {
      const { patch } = await getFileDiffAction(run.id, file.path)
      const parsed = parseUnifiedDiff(patch)
      setDiffCache((prev) => ({ ...prev, [file.path]: { patch, isBinary: parsed.isBinary } }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load diff.')
    } finally {
      setLoadingPath(null)
    }
  }

  async function handleApprove() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await approveAndMergeRun(run.id, workspaceSlug)
      if (result.merged) {
        setNotice(`Merged (${result.fastForward ? 'fast-forward' : 'merge commit'}${result.mergeCommit ? `: ${result.mergeCommit.slice(0, 10)}` : ''}).`)
      } else {
        setError(result.error ?? 'Merge did not complete.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve and merge.')
    } finally {
      setBusy(false)
    }
  }

  async function handleRequestChanges() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await requestChangesOnRun(run.id, workspaceSlug, requestNote)
      setNotice(`Requested changes — follow-up run #${result.followUpRunId} queued.`)
      setShowRequestForm(false)
      setRequestNote('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request changes.')
    } finally {
      setBusy(false)
    }
  }

  const selectedDiff = selected ? diffCache[selected.path] : null

  const primaryAction = (
    <>
      <Button
        type="button"
        size="sm"
        disabled={busy || run.status !== 'completed'}
        onClick={() => void handleApprove()}
        title={run.status !== 'completed' ? 'Only a completed run can be approved and merged.' : undefined}
      >
        Approve &amp; merge
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setShowRequestForm((v) => !v)}>
        Request changes
      </Button>
    </>
  )

  const diffTabContent = (
    <div className="flex min-h-0 flex-1 flex-col">
      {(showRequestForm || notice || error) && (
        <div className="border-b border-black/10 px-6 py-3 dark:border-white/10">
          {showRequestForm && (
            <div className="flex flex-col gap-2 rounded border border-black/10 p-3 dark:border-white/10">
              <textarea
                autoFocus
                value={requestNote}
                onChange={(e) => setRequestNote(e.target.value)}
                placeholder="What needs to change? (recorded on the task's Activity tab and queued as a follow-up run)"
                aria-label="What needs to change"
                rows={3}
                className="w-full rounded border border-black/10 bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:border-white/10"
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowRequestForm(false)} className="rounded px-3 py-1.5 text-xs hover:bg-black/[.06] dark:hover:bg-white/[.08]">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy || !requestNote.trim()}
                  onClick={() => void handleRequestChanges()}
                  className="rounded bg-black px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
                >
                  Queue follow-up run
                </button>
              </div>
            </div>
          )}
          {notice && <p className="mt-2 text-xs text-green-600 dark:text-green-400">{notice}</p>}
          {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}

      {!worktreeState.branchExists ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-black/50 dark:text-white/50">
            Nothing to review yet — no worktree/branch has been created for this run. That happens once a dispatcher actually
            executes the run (Pillar 4); until then there&apos;s no diff to show.
          </p>
          <Link
            href={`/workspace/${workspaceSlug}/review`}
            className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
          >
            Back to Review list
          </Link>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-72 shrink-0 overflow-y-auto border-r border-black/10 p-2 dark:border-white/10">
            {files.length === 0 ? (
              <p className="p-2 text-xs text-black/40 dark:text-white/40">No file changes.</p>
            ) : (
              <FileTree nodes={tree} expanded={expanded} onToggle={toggle} selected={selected} onSelect={(f) => void selectFile(f)} />
            )}
          </div>
          <div className="min-w-0 flex-1 overflow-auto">
            {!selected && <p className="p-6 text-sm text-black/40 dark:text-white/40">Select a file to view its diff.</p>}
            {selected && loadingPath === selected.path && <p className="p-6 text-sm text-black/40 dark:text-white/40">Loading diff…</p>}
            {selected && selectedDiff && selectedDiff.isBinary && (
              <p className="p-6 text-sm text-black/40 dark:text-white/40">Binary file — no textual diff.</p>
            )}
            {selected && selectedDiff && !selectedDiff.isBinary && (
              <DiffView lines={parseUnifiedDiff(selectedDiff.patch).lines} />
            )}
          </div>
        </div>
      )}
    </div>
  )

  const tabs: DetailLayoutTab[] = [
    { key: 'diff', label: 'Diff', count: files.length, content: diffTabContent },
  ]

  const rightRail = (
    <div className="flex flex-col gap-4 text-sm">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">Task</h2>
        {run.taskId ? (
          <Link
            href={`/workspace/${workspaceSlug}/tasks?task=${run.taskId}`}
            className="mt-1 block truncate font-medium hover:underline"
          >
            {taskTitle ?? `Task #${run.taskId}`}
          </Link>
        ) : (
          <p className="mt-1 text-black/50 dark:text-white/50">No linked task</p>
        )}
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">Agent</h2>
        <p className="mt-1">{agentName ?? 'Unassigned'}</p>
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">Run</h2>
        <p className="mt-1">
          #{run.id} · attempt {run.attempt}/{run.maxAttempts}
        </p>
        {run.startedAt && <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">started {formatTimestamp(run.startedAt)}</p>}
        {run.completedAt && <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">completed {formatTimestamp(run.completedAt)}</p>}
        {/* Where this run came from. Both ids sit on the run object and were
            rendered nowhere, so a reviewer looking at a diff had no way back
            to the conversation or the document that produced it. */}
        <div className="mt-1 flex flex-wrap gap-2 text-xs">
          {run.sessionId != null && (
            <Link
              href={`/workspace/${workspaceSlug}/work?session=${run.sessionId}`}
              className="text-black/60 underline underline-offset-2 hover:text-black dark:text-white/60 dark:hover:text-white"
            >
              Open conversation
            </Link>
          )}
          {run.pageId != null && (
            <Link
              href={`/workspace/${workspaceSlug}/p/${run.pageId}`}
              className="text-black/60 underline underline-offset-2 hover:text-black dark:text-white/60 dark:hover:text-white"
            >
              Open page
            </Link>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">Branch</h2>
        <div className="mt-1 flex flex-col gap-1 text-xs text-black/60 dark:text-white/60">
          <span className="flex items-center gap-1">
            <GitBranch size={12} />
            {worktreeState.branchExists ? 'branch created' : 'no branch'}
          </span>
          {worktreeState.branchExists && (
            <>
              <span>
                {worktreeState.aheadCount} ahead / {worktreeState.behindCount} behind base
              </span>
              {worktreeState.headCommit && <span className="font-mono">{worktreeState.headCommit.slice(0, 10)}</span>}
              {worktreeState.headSubject && <span className="italic">&ldquo;{worktreeState.headSubject}&rdquo;</span>}
            </>
          )}
          <span className={worktreeState.worktreeExists ? '' : 'italic'}>
            {worktreeState.worktreeExists ? 'worktree on disk' : 'worktree already cleaned up'}
          </span>
          {worktreeState.hasUncommittedChanges && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <FileWarning size={12} /> uncommitted changes in worktree
            </span>
          )}
        </div>
      </div>
    </div>
  )

  return (
    <DetailLayout
      breadcrumb={[
        { label: 'Review', href: `/workspace/${workspaceSlug}/review` },
        { label: `Run #${run.id}` },
      ]}
      title={`Run #${run.id}`}
      statusBadge={<Badge variant={STATUS_BADGE_VARIANT[run.status]}>{run.status}</Badge>}
      primaryAction={primaryAction}
      tabs={tabs}
      defaultTab="diff"
      rightRail={rightRail}
    />
  )
}

function FileTree({
  nodes,
  expanded,
  onToggle,
  selected,
  onSelect,
  depth = 0,
}: {
  nodes: TreeNode[]
  expanded: Set<string>
  onToggle: (path: string) => void
  selected: ChangedFile | null
  onSelect: (file: ChangedFile) => void
  depth?: number
}) {
  return (
    <div style={{ paddingLeft: depth ? 12 : 0 }}>
      {nodes.map((node) =>
        node.file ? (
          <button
            key={node.path}
            type="button"
            onClick={() => onSelect(node.file!)}
            className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs ${
              selected?.path === node.file.path ? 'bg-black/[.06] dark:bg-white/[.08]' : 'hover:bg-black/[.04] dark:hover:bg-white/[.06]'
            }`}
          >
            <span className={`shrink-0 font-mono font-semibold ${STATUS_STYLES[node.file.status]}`}>{STATUS_LABELS[node.file.status]}</span>
            <File size={12} className="shrink-0 text-black/40 dark:text-white/40" />
            <span className="truncate">{node.name}</span>
          </button>
        ) : (
          <div key={node.path}>
            <button
              type="button"
              onClick={() => onToggle(node.path)}
              className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs font-medium hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            >
              {expanded.has(node.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {node.name}
            </button>
            {expanded.has(node.path) && (
              <FileTree nodes={node.children} expanded={expanded} onToggle={onToggle} selected={selected} onSelect={onSelect} depth={depth + 1} />
            )}
          </div>
        ),
      )}
    </div>
  )
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  if (lines.length === 0) return <p className="p-6 text-sm text-black/40 dark:text-white/40">No textual changes (mode-only change?).</p>
  return (
    <div className="font-mono text-xs">
      {lines.map((line, idx) => (
        <div
          key={idx}
          className={`flex ${
            line.type === 'add'
              ? 'bg-green-500/10'
              : line.type === 'remove'
                ? 'bg-red-500/10'
                : line.type === 'hunk-header'
                  ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300'
                  : line.type === 'meta'
                    ? 'text-black/30 dark:text-white/30'
                    : ''
          }`}
        >
          <span className="w-10 shrink-0 select-none px-1.5 text-right text-black/30 dark:text-white/30">{line.oldLineNo ?? ''}</span>
          <span className="w-10 shrink-0 select-none px-1.5 text-right text-black/30 dark:text-white/30">{line.newLineNo ?? ''}</span>
          <span className="shrink-0 px-1 select-none">{line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all px-1">{line.text}</span>
        </div>
      ))}
    </div>
  )
}

import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getRun } from '@/lib/broker'
import { loadRunReview, locateRunWorktree } from '@/lib/run-worktrees/review'
import { getFileDiff } from '@/lib/run-worktrees/diff'
import { listReviewComments } from '@/lib/review-comments'
import { ReviewSurface } from '@/components/review/review-surface'

// ROADMAP R5.2 / R5.3 — the review surface: side-by-side diff (via
// `@git-diff-view/react`, chosen because line-anchored comments need arbitrary
// React widgets pinned to a side and a line) with comments that accumulate and
// are sent to the agent as ONE prompt.
//
// This route now renders `components/review/review-surface.tsx` instead of
// `components/runs/review-panel.tsx`. The old panel's inline renderer had no
// way to host a widget inside the scroll flow, and it was outside this unit's
// owned paths so it could not be extended in place; it is now unreferenced and
// should be deleted during integration.
export default async function RunReviewPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; runId: string }>
}) {
  const { workspaceSlug, runId: runIdParam } = await params
  const runId = Number(runIdParam)
  if (!Number.isFinite(runId)) notFound()

  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const run = await getRun(runId)
  if (!run) notFound()

  const payload = await getPayloadClient()
  const [task, agent, review, comments] = await Promise.all([
    run.taskId
      ? payload.findByID({ collection: 'tasks', id: run.taskId, depth: 0, overrideAccess: true, disableErrors: true })
      : null,
    run.agentId
      ? payload.findByID({ collection: 'agents', id: run.agentId, depth: 0, overrideAccess: true, disableErrors: true })
      : null,
    loadRunReview(runId),
    // Every comment on this run in one query, handed to the client with the
    // file list — the diff arrives with its annotations already on it instead
    // of painting and then filling in (D0).
    listReviewComments(runId),
  ])

  // Only the first file's patch is fetched here, not all of them: `git diff`
  // is one process per file (see lib/run-worktrees/diff.ts), so pre-fetching a
  // 200-file review would spawn 200 of them to render one. The first file is
  // the one that is definitely about to be shown, and the rest are prefetched
  // on hover in the client. Failure is swallowed to a null patch rather than
  // failing the page — the client's own loader will report it properly.
  const firstFile = review.files[0]
  let initialPatches: Record<string, string> = {}
  if (firstFile) {
    try {
      initialPatches = { [firstFile.path]: await getFileDiff(locateRunWorktree(runId), firstFile) }
    } catch {
      initialPatches = {}
    }
  }

  return (
    <ReviewSurface
      workspaceSlug={workspace.slug}
      run={run}
      taskTitle={task?.title ?? null}
      agentName={agent?.name ?? null}
      worktreeState={review.state}
      files={review.files}
      initialComments={comments}
      initialPatches={initialPatches}
    />
  )
}

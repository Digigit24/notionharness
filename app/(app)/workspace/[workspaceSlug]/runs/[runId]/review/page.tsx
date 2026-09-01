import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getRun } from '@/lib/broker'
import { loadRunReview } from '@/lib/run-worktrees/review'
import { ReviewPanel } from '@/components/runs/review-panel'

// ROADMAP P6.4 — "this is where the loop closes and a run becomes shipped
// work rather than a suggestion." First pass: file tree + inline diff
// viewer (not side-by-side — see review-panel.tsx for why), approve-and-merge,
// and a request-changes action that enqueues a real follow-up run (not a
// stub — see actions.ts). Comment-on-a-line threading is explicitly out of
// scope for this pass per the task brief.
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
  const [task, agent, review] = await Promise.all([
    run.taskId
      ? payload.findByID({ collection: 'tasks', id: run.taskId, depth: 0, overrideAccess: true, disableErrors: true })
      : null,
    run.agentId
      ? payload.findByID({ collection: 'agents', id: run.agentId, depth: 0, overrideAccess: true, disableErrors: true })
      : null,
    loadRunReview(runId),
  ])

  return (
    <ReviewPanel
      workspaceSlug={workspace.slug}
      run={run}
      taskTitle={task?.title ?? null}
      agentName={agent?.name ?? null}
      worktreeState={review.state}
      files={review.files}
    />
  )
}

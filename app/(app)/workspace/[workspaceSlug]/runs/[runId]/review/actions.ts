'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { recordActivity } from '@/lib/activity'
import { getRun, enqueueRun } from '@/lib/broker'
import { loadFileDiff, approveMerge } from '@/lib/run-worktrees/review'

export async function getFileDiffAction(runId: number, path: string) {
  return loadFileDiff(runId, path)
}

// Activity is recorded against the TASK (entityType: 'task'), not the run —
// `run` is already a listed `ACTIVITY_ENTITY_TYPES` value for later use, but
// today only the task's own Activity tab (P2.6) is a real, visible surface,
// and every reviewable run has a task. Recording here means "approved" and
// "changes requested" show up immediately in the timeline a user already
// looks at, with the specific run id preserved in `payload` for traceability.
export async function approveAndMergeRun(runId: number, workspaceSlug: string) {
  const run = await getRun(runId)
  if (!run) throw new Error(`Run ${runId} not found.`)
  if (run.status !== 'completed') {
    throw new Error(`Run ${runId} is "${run.status}" — only a completed run can be approved and merged.`)
  }

  const result = await approveMerge(runId)

  if (run.taskId) {
    const payload = await getPayloadClient()
    const user = await getCurrentPayloadUser()
    try {
      await recordActivity({
        payload,
        entityType: 'task',
        entityId: String(run.taskId),
        actor: user?.id,
        action: result.merged ? 'run_approved_and_merged' : 'run_approve_failed',
        details: { runId, fastForward: result.fastForward, mergeCommit: result.mergeCommit, error: result.error },
      })
    } catch (err) {
      console.error('[review] Failed to record approve/merge activity.', err)
    }
    revalidatePath(`/workspace/${workspaceSlug}/tasks`)
  }

  return result
}

export async function requestChangesOnRun(runId: number, workspaceSlug: string, note: string) {
  const run = await getRun(runId)
  if (!run) throw new Error(`Run ${runId} not found.`)
  if (run.taskId == null || run.agentId == null) {
    throw new Error('This run has no task/agent to re-enqueue a follow-up run against.')
  }

  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in to request changes.')

  // A REAL follow-up run, not a stub: same task+agent pair, fresh queued
  // row. `enqueueRun`'s partial unique index only blocks a second
  // *non-terminal* run for the same (task, agent) — this run is required to
  // be settled already (see the taskId/agentId check above doesn't enforce
  // that, but in practice you review a run once it's done), so this is safe
  // the overwhelming majority of the time; a genuine race (someone
  // re-assigned the same agent moments earlier) surfaces as a normal
  // thrown/caught DB error below rather than silently double-queuing.
  let followUp
  try {
    followUp = await enqueueRun({
      taskId: run.taskId,
      agentId: run.agentId,
      originatorUser: user.id,
      accountableUser: user.id,
    })
  } catch (err) {
    throw new Error(
      `Could not enqueue a follow-up run (an active run may already exist for this task/agent): ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const payload = await getPayloadClient()
  try {
    await recordActivity({
      payload,
      entityType: 'task',
      entityId: String(run.taskId),
      actor: user.id,
      action: 'run_changes_requested',
      details: { runId, note, followUpRunId: followUp.id },
    })
  } catch (err) {
    console.error('[review] Failed to record changes-requested activity.', err)
  }

  revalidatePath(`/workspace/${workspaceSlug}/tasks`)
  return { followUpRunId: followUp.id }
}

'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { guard, raise, type WithFailure } from '@/lib/failures'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { recordActivity } from '@/lib/activity'
import { getRun, enqueueRun } from '@/lib/broker'
import { loadFileDiff, approveMerge, locateRunWorktree } from '@/lib/run-worktrees/review'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
// R5.3 sends a batch into the run's own conversation when it has one, and
// `sendSessionMessage` is already the single place that knows how to do that
// correctly — it validates the session against the workspace, writes the
// user's own message as run event seq 1 (without which the thread renders
// nothing for "what I just said"), titles an untitled session and touches it.
// Re-implementing any of that here would be a second, quietly divergent copy.
import { sendSessionMessage } from '@/app/(app)/workspace/[workspaceSlug]/work/actions'
import {
  addReviewComment,
  composeReviewPrompt,
  deleteReviewComment,
  listOpenReviewComments,
  markReviewCommentsSent,
  type ReviewCommentSide,
} from '@/lib/review-comments'

export async function getFileDiffAction(runId: number, path: string) {
  // Guarded even though the body is one call: `loadFileDiff` shells out to
  // git, so the failures worth reading here are git's own — a branch that
  // was deleted between the page rendering and this click, a worktree that
  // retention has reclaimed — and they arrive with their stderr attached.
  return guard(async () => loadFileDiff(runId, path))
}

// Activity is recorded against the TASK (entityType: 'task'), not the run —
// `run` is already a listed `ACTIVITY_ENTITY_TYPES` value for later use, but
// today only the task's own Activity tab (P2.6) is a real, visible surface,
// and every reviewable run has a task. Recording here means "approved" and
// "changes requested" show up immediately in the timeline a user already
// looks at, with the specific run id preserved in `payload` for traceability.
export async function approveAndMergeRun(runId: number, workspaceSlug: string) {
  return guard(async () => {
    const run = await getRun(runId)
    if (!run) raise('not_found', `Run ${runId} not found.`)
    if (run.status !== 'completed') {
      raise('conflict', `Run ${runId} is "${run.status}" — only a completed run can be approved and merged.`)
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
  })
}

export async function requestChangesOnRun(runId: number, workspaceSlug: string, note: string) {
  return guard(async () => {
    const run = await getRun(runId)
    if (!run) raise('not_found', `Run ${runId} not found.`)
    if (run.taskId == null || run.agentId == null) {
      raise('conflict', 'This run has no task/agent to re-enqueue a follow-up run against.')
    }

    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in to request changes.')

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
      raise('conflict', 'Could not enqueue a follow-up run — an active run may already exist for this task and agent.', {
        detail: err instanceof Error ? err.message : String(err),
      })
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
  })
}

// --- R5.3: line-anchored comments, batched into one prompt -----------------

export async function addReviewCommentAction(input: {
  runId: number
  filePath: string
  side: ReviewCommentSide
  lineNumber: number
  body: string
  lineContent?: string | null
}) {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in to comment.')
    const body = input.body.trim()
    if (!body) raise('invalid_input', 'A comment cannot be empty.')
    if (body.length > 10_000) raise('invalid_input', 'A comment must be under 10,000 characters.')

    // Existence check on the run and nothing more: the file path and line come
    // from a diff this same server rendered, and the only thing a forged value
    // could produce is a comment quoting a path that isn't in the diff — which
    // the reviewer sees immediately. Re-listing the changed files to validate
    // the path would cost a `git diff` on the keystroke path of every comment,
    // which is the sort of round trip D0 exists to prevent.
    const run = await getRun(input.runId)
    if (!run) raise('not_found', `Run ${input.runId} not found.`)

    return addReviewComment({ ...input, body, authorUserId: user.id })
  })
}

export async function deleteReviewCommentAction(runId: number, commentId: number) {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')
    await deleteReviewComment(runId, commentId)
  })
}

export interface SendReviewCommentsResult {
  commentCount: number
  /** Where the batch actually went. A run bound to a conversation gets it as
   * one more turn IN that conversation (same worktree, full history); a
   * task-scoped run has no conversation to speak into and gets a fresh run. */
  deliveredAs: 'session-turn' | 'follow-up-run'
  runId: number
  /**
   * False when the composed prompt could NOT be handed to the agent. This is
   * not defensive padding — it is a real, currently-reachable case: for a
   * run with a task attached, `buildPromptText` in lib/dispatcher/worker.ts
   * builds the agent's prompt as `task ? "Task: ${title}" : run.prompt`, so
   * `run.prompt` is dropped outright whenever `task_id` is set. Fixing that
   * means editing the dispatcher, which is outside this unit's owned files.
   * Rather than pretend the comments were delivered, the surface says so and
   * the composed text is preserved on the task's Activity entry so the work
   * is not lost.
   */
  promptDelivered: boolean
  prompt: string
  /**
   * The comment ids that were actually flipped to 'sent' by THIS call, so the
   * client flips exactly those rather than its own pre-send snapshot. The
   * snapshot is wrong in two directions: it contains optimistic negative ids
   * whose insert had not landed when the server read the batch (shown as sent
   * when they were not), and it misses a comment that landed between the
   * snapshot and the read. Empty when nothing was delivered — see
   * `promptDelivered`.
   */
  sentCommentIds: number[]
}

/**
 * R5.3's single action: every open comment on this run, composed into ONE
 * prompt, sent as ONE turn. Marking the batch sent happens after delivery, so
 * a failed send leaves the comments open and re-sendable rather than silently
 * consuming them.
 */
export async function sendReviewCommentsAction(
  runId: number,
  workspaceSlug: string,
  note: string,
): Promise<WithFailure<SendReviewCommentsResult>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in to send review comments.')

    const run = await getRun(runId)
    if (!run) raise('not_found', `Run ${runId} not found.`)

    const comments = await listOpenReviewComments(runId)
    if (comments.length === 0 && !note.trim()) {
      raise('invalid_input', 'Nothing to send — add a line comment or a note first.')
    }

    const prompt = composeReviewPrompt({
      runId,
      comments,
      note,
      branch: locateRunWorktree(runId).branch,
    })

    // Preferred path by a distance: the run belongs to a conversation, so the
    // batch becomes one more message in it. That keeps the agent's own history
    // and — because `resolveWorktree` in the dispatcher binds a session run to
    // `session.worktree_id` — makes the revision happen in the SAME checkout
    // the diff was read from, instead of a fresh branch off base.
    if (run.sessionId != null) {
      const workspace = await getWorkspaceBySlug(workspaceSlug)
      if (!workspace) raise('not_found', `Workspace ${workspaceSlug} not found.`)
      // `sendSessionMessage` caps a turn at 20,000 characters. Checked here so
      // an over-long batch fails with a message that names the actual problem
      // (too many/too long comments for one turn) instead of the composer's
      // generic "a message between 1 and 20,000 characters is required", and
      // fails BEFORE anything is marked sent.
      if (prompt.length > 20_000) {
        raise(
          'invalid_input',
          `This batch composes to ${prompt.length.toLocaleString()} characters, over the 20,000-character limit for one turn. Send some of the comments first, or shorten the longest ones.`,
        )
      }
      const { runId: turnRunId } = await sendSessionMessage({
        sessionId: run.sessionId,
        workspaceId: workspace.id,
        workspaceSlug,
        prompt,
      })
      const sentIds = comments.map((c) => c.id)
      await markReviewCommentsSent(sentIds, turnRunId)
      revalidatePath(`/workspace/${workspaceSlug}/runs/${runId}/review`)
      return {
        commentCount: comments.length,
        deliveredAs: 'session-turn',
        runId: turnRunId,
        promptDelivered: true,
        prompt,
        sentCommentIds: sentIds,
      }
    }

    if (run.taskId == null || run.agentId == null) {
      raise('conflict', 'This run has neither a conversation nor a task/agent to send the review to.')
    }

    let followUp
    try {
      followUp = await enqueueRun({
        taskId: run.taskId,
        agentId: run.agentId,
        originatorUser: user.id,
        accountableUser: user.id,
        prompt,
      })
    } catch (err) {
      raise('conflict', 'Could not enqueue a follow-up run — an active run may already exist for this task and agent.', {
        detail: err instanceof Error ? err.message : String(err),
      })
    }

    // Deliberately NOT marked sent. `promptDelivered` is false on this path —
    // the dispatcher drops a task-scoped run's `run.prompt` (buildPromptText in
    // lib/dispatcher/worker.ts), so the agent never receives these comments.
    // Flipping them to 'sent' would consume the review anyway: 'sent' rows are
    // excluded from every later batch and are not deletable in the UI, so once
    // the dispatcher is fixed there would be no way to actually deliver them
    // short of retyping the lot. Leaving them open costs an unavoidable "an
    // active run already exists" error if you press send twice; losing the
    // review silently costs the review.

    const payload = await getPayloadClient()
    try {
      await recordActivity({
        payload,
        entityType: 'task',
        entityId: String(run.taskId),
        actor: user.id,
        // The full composed prompt is recorded, not just a count: this is the
        // only place it survives for a task-scoped run, given the dispatcher
        // drops `run.prompt` when a task is attached (see promptDelivered).
        action: 'run_changes_requested',
        details: { runId, note, followUpRunId: followUp.id, commentCount: comments.length, prompt },
      })
    } catch (err) {
      console.error('[review] Failed to record batched-comments activity.', err)
    }

    revalidatePath(`/workspace/${workspaceSlug}/runs/${runId}/review`)
    revalidatePath(`/workspace/${workspaceSlug}/tasks`)
    return {
      commentCount: comments.length,
      deliveredAs: 'follow-up-run',
      runId: followUp.id,
      promptDelivered: false,
      prompt,
      sentCommentIds: [],
    }
  })
}

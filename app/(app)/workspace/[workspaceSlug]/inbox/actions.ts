'use server'

// ROADMAP B5.2 (Batch B-5 "Attention") — the Inbox's real inline actions.
// "Every row carries its action inline: approve, retry, review, open... the
// measure is whether a person can clear it in five minutes and trust that
// nothing is stuck." Every action here verifies the acting user actually
// owns the item before mutating it — identity always comes from the
// authenticated session (`getCurrentPayloadUser`), never a client-supplied
// id, same rule app/api/approvals/route.ts already documents.
import { revalidatePath } from 'next/cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getApproval, resolveApproval } from '@/lib/hermes/approval-helpers'
import { getRun, enqueueRun, dismissRun, type Run } from '@/lib/broker'
import { markNotificationsRead } from '@/app/(app)/notifications/actions'

function revalidateInbox(workspaceSlug: string) {
  revalidatePath(`/workspace/${workspaceSlug}/inbox`)
  revalidatePath('/', 'layout') // keeps the bell's unread count in sync
}

export async function approveApprovalInbox(workspaceSlug: string, approvalId: number, selectedOptionId?: string): Promise<void> {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')

  const approval = await getApproval(approvalId)
  if (!approval) throw new Error('Approval not found.')
  if (approval.requestedUser !== user.id) throw new Error('You do not have access to this approval.')

  await resolveApproval(approvalId, { approved: true, selectedOptionId })
  revalidateInbox(workspaceSlug)
}

export async function denyApprovalInbox(workspaceSlug: string, approvalId: number): Promise<void> {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')

  const approval = await getApproval(approvalId)
  if (!approval) throw new Error('Approval not found.')
  if (approval.requestedUser !== user.id) throw new Error('You do not have access to this approval.')

  await resolveApproval(approvalId, { approved: false, reason: 'denied from inbox' })
  revalidateInbox(workspaceSlug)
}

function ownsRun(run: Run, userId: number): boolean {
  return run.accountableUser === userId || run.originatorUser === userId
}

/** Re-enqueues a fresh run with the same task/agent/prompt attribution as
 * the failed run, then dismisses the failed row — a retry is the user
 * saying "I've handled this," so the old failed entry shouldn't linger next
 * to its own successor. Only meaningful for a run that actually had an
 * agent (nothing to dispatch a fresh attempt to otherwise) — the inbox UI
 * only renders the Retry action when `agentId` is set, but this is
 * re-checked here since server actions must never trust client-side gating
 * alone. */
export async function retryRunInbox(workspaceSlug: string, runId: number): Promise<Run> {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')

  const run = await getRun(runId)
  if (!run) throw new Error('Run not found.')
  if (!ownsRun(run, user.id)) throw new Error('You do not have access to this run.')
  if (run.agentId == null) throw new Error('This run has no agent to retry with.')

  const retried = await enqueueRun({
    taskId: run.taskId,
    agentId: run.agentId,
    originatorUser: user.id,
    accountableUser: run.accountableUser,
    prompt: run.prompt,
    pageId: run.pageId,
  })
  await dismissRun(runId)
  revalidateInbox(workspaceSlug)
  return retried
}

/** "Zero-able" — clears a failed or review-ready run out of the Inbox
 * without changing its outcome (lib/broker/runs.ts's `dismissRun`). */
export async function dismissRunInbox(workspaceSlug: string, runId: number): Promise<void> {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')

  const run = await getRun(runId)
  if (!run) throw new Error('Run not found.')
  if (!ownsRun(run, user.id)) throw new Error('You do not have access to this run.')

  await dismissRun(runId)
  revalidateInbox(workspaceSlug)
}

/** A mention is "dismissed once opened/read" per the plan — both the inline
 * dismiss action and opening the row's link mark the same underlying
 * notification read. `markNotificationsRead` already scopes to the calling
 * user internally (it only ever updates rows returned by a user-scoped
 * find), so no extra ownership check is needed here. */
export async function dismissMentionInbox(workspaceSlug: string, notificationId: number): Promise<void> {
  await markNotificationsRead([notificationId])
  revalidateInbox(workspaceSlug)
}

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
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getApproval, resolveApproval } from '@/lib/hermes/approval-helpers'
import type { ApprovalStatus } from '@/collections/Approvals'
import { getChannelMessage, listThread, getRun, enqueueRun, dismissRun, markChannelRead, type Run } from '@/lib/broker'
import { markNotificationsRead } from '@/app/(app)/notifications/actions'
import { guard, raise, type WithFailure } from '@/lib/failures'
// Read-only server helpers, deliberately NOT actions — see that file's header
// note on why an exported async function in a `'use server'` module is a public
// endpoint. Imported rather than re-implemented so there is exactly one way a
// slot id is ever chosen for a write.
import { getChannel, resolveMySlot, loadSlots } from '../teams/data'
import type { RoomFeedMessage, TeamSlotView } from '@/components/teams/shared'

function revalidateInbox(workspaceSlug: string) {
  revalidatePath(`/workspace/${workspaceSlug}/inbox`)
  revalidatePath('/', 'layout') // keeps the bell's unread count in sync
}

export async function approveApprovalInbox(
  workspaceSlug: string,
  approvalId: number,
  selectedOptionId?: string,
): Promise<WithFailure<void>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')

    const approval = await getApproval(approvalId)
    if (!approval) raise('not_found', 'Approval not found.')
    if (approval.requestedUser !== user.id) raise('forbidden', 'You do not have access to this approval.')

    await resolveApproval(approvalId, { approved: true, selectedOptionId })
    revalidateInbox(workspaceSlug)
  })
}

export async function denyApprovalInbox(workspaceSlug: string, approvalId: number): Promise<WithFailure<void>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')

    const approval = await getApproval(approvalId)
    if (!approval) raise('not_found', 'Approval not found.')
    if (approval.requestedUser !== user.id) raise('forbidden', 'You do not have access to this approval.')

    await resolveApproval(approvalId, { approved: false, reason: 'denied from inbox' })
    revalidateInbox(workspaceSlug)
  })
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
export async function retryRunInbox(workspaceSlug: string, runId: number): Promise<WithFailure<Run>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')

    const run = await getRun(runId)
    if (!run) raise('not_found', 'Run not found.')
    if (!ownsRun(run, user.id)) raise('forbidden', 'You do not have access to this run.')
    if (run.agentId == null) raise('run_not_retryable', 'This run has no agent to retry with.')

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
  })
}

/** "Zero-able" — clears a failed or review-ready run out of the Inbox
 * without changing its outcome (lib/broker/runs.ts's `dismissRun`). */
export async function dismissRunInbox(workspaceSlug: string, runId: number): Promise<WithFailure<void>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')

    const run = await getRun(runId)
    if (!run) raise('not_found', 'Run not found.')
    if (!ownsRun(run, user.id)) raise('forbidden', 'You do not have access to this run.')

    await dismissRun(runId)
    revalidateInbox(workspaceSlug)
  })
}

/** A mention is "dismissed once opened/read" per the plan — both the inline
 * dismiss action and opening the row's link mark the same underlying
 * notification read. `markNotificationsRead` already scopes to the calling
 * user internally (it only ever updates rows returned by a user-scoped
 * find), so no extra ownership check is needed here. */
export async function dismissMentionInbox(workspaceSlug: string, notificationId: number): Promise<WithFailure<void>> {
  return guard(async () => {
    await markNotificationsRead([notificationId])
    revalidateInbox(workspaceSlug)
  })
}

/**
 * Clears a CHANNEL mention — the cross-channel Mentions rows in the Inbox.
 *
 * A channel mention clears the way a channel clears: by moving the reader's
 * own read cursor. `team_messages` has no per-message "acknowledged" flag and
 * this unit does not get to add one — a second notifications store beside the
 * `mentions` GIN index is precisely the thing the brief rules out. So this
 * means what "mark read" means in the room: caught up in #channel through this
 * message. It therefore also clears any OLDER unread mention in the same
 * channel, which is why the button reads "Mark read" and not "Dismiss" — the
 * act is channel-level, and labelling it per-row would be a lie the very next
 * render exposes. (`markChannelRead` is GREATEST(), so it never rewinds and is
 * idempotent when the room marks the same message read a moment later.)
 *
 * Every id here is re-derived server-side, because all three of them arrive
 * from a browser:
 *   - `teamId` is read off the message row, never accepted from the client.
 *   - the channel must belong to the workspace whose slug was routed to.
 *   - the slot whose cursor moves is the caller's OWN slot in that channel.
 * Drop the last check and this endpoint becomes "move anybody's read cursor in
 * any channel, by id" — the exact shape of the cross-workspace holes this repo
 * has already been bitten by. The membership test is the real authorisation;
 * the workspace test is defence in depth and keeps `revalidatePath` honest.
 */
export async function markChannelMentionRead(workspaceSlug: string, messageId: number): Promise<WithFailure<void>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')
    if (!Number.isSafeInteger(messageId) || messageId <= 0) raise('invalid_input', 'Invalid message.')

    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) raise('not_found', 'Workspace not found.')

    const message = await getChannelMessage(messageId)
    if (!message) raise('not_found', 'Message not found.')

    const channel = await getChannel(message.teamId)
    if (!channel || channel.workspaceId !== workspace.id) raise('forbidden', 'You do not have access to this channel.')

    const slot = await resolveMySlot(channel.id, user.id)
    if (!slot) raise('forbidden', 'You are not a member of this channel.')

    await markChannelRead(slot.id, message.id)
    revalidateInbox(workspaceSlug)
  })
}

/**
 * The Inbox's own right-pane thread preview — R14-P0.9.
 *
 * `components/inbox/inbox-thread-preview.tsx` reuses `MessageRow` (the same
 * renderer `components/teams/thread-pane.tsx` uses) but that pane's own data
 * flow is channel-room-specific (live SSE state, the room's full roster,
 * run/task maps) and does not exist on this route. This is the "focused
 * equivalent" the roadmap asks for: one thread's root + replies, the caller's
 * own slot (so "mine" reactions render correctly) and the channel's roster for
 * names — nothing the room's live wiring would otherwise supply.
 *
 * Deliberately does NOT call `mergeReliability`/`listTeamRoomMessages`: that
 * query scans up to 1000 room-system rows per channel to resolve `systemKind`/
 * `undeliverableAt` for messages that, in a MENTION preview, are essentially
 * never system rows. Paying for it here would be a query this surface does not
 * need (D0) for cosmetic fields defaulted to their empty state below.
 */
export interface InboxThreadPreview {
  workspaceId: number
  teamId: number
  channelName: string
  rootId: number
  messages: RoomFeedMessage[]
  slots: TeamSlotView[]
  mySlotId: number | null
}

export async function getInboxThreadPreview(
  workspaceSlug: string,
  messageId: number,
): Promise<WithFailure<InboxThreadPreview>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')
    if (!Number.isSafeInteger(messageId) || messageId <= 0) raise('invalid_input', 'Invalid message.')

    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) raise('not_found', 'Workspace not found.')

    const message = await getChannelMessage(messageId)
    if (!message) raise('not_found', 'Message not found.')

    const channel = await getChannel(message.teamId)
    if (!channel || channel.workspaceId !== workspace.id) raise('forbidden', 'You do not have access to this channel.')

    // Same authorization as `markChannelMentionRead`: a non-null slot IS
    // membership in this schema, so this is both the identity check and the
    // access check in one query.
    const slot = await resolveMySlot(channel.id, user.id)
    if (!slot) raise('forbidden', 'You are not a member of this channel.')

    const rootId = message.threadRootId ?? message.id
    const [thread, slots] = await Promise.all([listThread(rootId), loadSlots(channel.id)])
    if (thread.length === 0) raise('not_found', 'That thread is no longer in this channel.')

    const messages: RoomFeedMessage[] = thread.map((m) => ({
      ...m,
      systemKind: null,
      undeliverableAt: null,
      addresseeMissing: false,
    }))

    return {
      workspaceId: workspace.id,
      teamId: channel.id,
      channelName: channel.name,
      rootId,
      messages,
      slots,
      mySlotId: slot.id,
    }
  })
}

/**
 * A bounded, one-shot follow-up — NOT a poll. `components/thread/PermissionCard`
 * (reused wholesale for the approval preview, per this unit's brief) owns its
 * own decision POST to `/api/approvals` and exposes no callback, so this Inbox
 * pane cannot learn synchronously that a decision landed. Rather than build a
 * second decision control beside it (the exact duplication the brief says to
 * avoid) or poll on an interval (D0 forbids that), the preview calls this ONCE,
 * a short delay after it observes a click inside the card — see
 * `inbox-approval-preview.tsx`. `status !== 'pending'` is the caller's signal
 * to remove the row locally, the same way every other resolved action here
 * does.
 */
export async function getApprovalStatusInbox(
  workspaceSlug: string,
  approvalId: number,
): Promise<WithFailure<{ status: ApprovalStatus }>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')

    const approval = await getApproval(approvalId)
    if (!approval) raise('not_found', 'Approval not found.')
    if (approval.requestedUser !== user.id) raise('forbidden', 'You do not have access to this approval.')

    // The decision travelled through a different endpoint (`/api/approvals`),
    // which has no reason to know this route exists and does not revalidate
    // it. Doing that here, once, is what lets the bell and a future visit to
    // this page agree with what the card already shows.
    if (approval.status !== 'pending') revalidateInbox(workspaceSlug)

    return { status: approval.status }
  })
}

import { getPayloadClient } from '@/lib/payload'
import { bestEffort } from '@/lib/failures'
import type { ApprovalOption, ApprovalStatus } from '@/collections/Approvals'
import type { ApprovalOutcome } from '@/lib/run-events'

const pendingApprovalWaiters = new Map<
  string,
  {
    resolve: (outcome: ApprovalOutcome) => void
    reject: (err: Error) => void
  }
>()

export interface CreateApprovalParams {
  runId: number
  externalId: string
  requestedUserId: number
  title: string
  detail: string
  options: ApprovalOption[]
}

export async function createPendingApproval(
  params: CreateApprovalParams
): Promise<number> {
  const payload = await getPayloadClient()
  const doc = await payload.create({
    collection: 'approvals',
    data: {
      runId: params.runId,
      externalId: params.externalId,
      requestedUser: params.requestedUserId,
      title: params.title,
      detail: params.detail,
      options: params.options,
      status: 'pending',
    },
    overrideAccess: true,
  })
  return doc.id as number
}

export async function waitForApproval(
  externalId: string,
  timeoutMs: number
): Promise<ApprovalOutcome> {
  const deferred = pendingApprovalWaiters.get(externalId)
  if (deferred) {
    throw new Error(`Approval waiter for ${externalId} already exists`)
  }

  let timeoutHandle: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<ApprovalOutcome>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve({ outcome: 'cancelled', reason: 'timeout' })
    }, timeoutMs)
  })

  const waiterPromise = new Promise<ApprovalOutcome>((resolve, reject) => {
    pendingApprovalWaiters.set(externalId, { resolve, reject })
  })

  try {
    const outcome = await Promise.race([waiterPromise, timeoutPromise])
    // R3.6 — a timeout has to settle in the DATABASE too, not just here.
    // The `timeout` status has existed on the collection since it was
    // written and nothing ever wrote it, so a request nobody answered stayed
    // `pending` forever: it kept its place in the approvals list and stayed
    // clickable long after the agent had given up waiting and moved on.
    // Answering it then did nothing at all, with no explanation.
    if (outcome.outcome === 'cancelled' && outcome.reason === 'timeout') {
      await markApprovalTimedOut(externalId)
    }
    return outcome
  } finally {
    clearTimeout(timeoutHandle!)
    pendingApprovalWaiters.delete(externalId)
  }
}

/**
 * Closes out an approval nobody answered in time.
 *
 * Scoped to rows still `pending` so it can never overwrite a decision that
 * landed in the same instant the timer fired — the human's answer wins that
 * race, which is the right way round. Never throws: the turn has already
 * moved on, and a bookkeeping failure must not become a run failure.
 */
async function markApprovalTimedOut(externalId: string): Promise<void> {
  await bestEffort(
    async () => {
      const payload = await getPayloadClient()
      const timedOut: ApprovalStatus = 'timeout'
      await payload.update({
        collection: 'approvals',
        where: { externalId: { equals: externalId }, status: { equals: 'pending' } },
        data: { status: timedOut },
        overrideAccess: true,
      })
    },
    'the waiter has already been answered with a denial; a stale row must not also fail the turn',
    { externalId },
  )
}

export async function resolveApproval(
  approvalId: number,
  decision: { approved: boolean; selectedOptionId?: string; reason?: string }
): Promise<void> {
  const payload = await getPayloadClient()

  const { docs: [approval] } = await payload.find({
    collection: 'approvals',
    where: { id: { equals: approvalId } },
    limit: 1,
    overrideAccess: true,
  })

  if (!approval) throw new Error(`Approval ${approvalId} not found`)

  const externalId = (approval as { externalId?: string }).externalId ?? ''
  const status: ApprovalStatus = decision.approved ? 'approved' : 'denied'

  await payload.update({
    collection: 'approvals',
    id: approvalId,
    data: {
      status,
      selectedOptionId: decision.selectedOptionId ?? null,
    },
    overrideAccess: true,
  })

  const waiter = pendingApprovalWaiters.get(externalId)
  if (waiter) {
    if (decision.approved && decision.selectedOptionId) {
      waiter.resolve({ outcome: 'selected', optionId: decision.selectedOptionId })
    } else {
      waiter.resolve({ outcome: 'cancelled', reason: decision.reason ?? 'denied' })
    }
  }
}

export async function listPendingApprovalsForUser(userId: number) {
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'approvals',
    where: {
      requestedUser: { equals: userId },
      status: { equals: 'pending' },
    },
    limit: 100,
    depth: 0,
    overrideAccess: true,
  })
  return result.docs as ApprovalDoc[]
}

export interface ApprovalDoc {
  id: number
  runId: number | null
  externalId: string
  requestedUser: number
  title: string
  detail: string
  options: ApprovalOption[]
  status: ApprovalStatus
  selectedOptionId: string | null
  createdAt: string
  updatedAt: string
}

/** Looks a pending approval up by the ACP request id carried in the RunEvent
 * stream, which is the only handle the in-chat approval card has. Scoped to
 * `pending` so a re-submitted decision can't reopen a settled request. */
export async function getApprovalByExternalId(externalId: string) {
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'approvals',
    where: { externalId: { equals: externalId }, status: { equals: 'pending' } },
    limit: 1,
    // `requestedUser` is a relationship. At Payload's default depth it comes
    // back as a populated user OBJECT, and every caller compares it to a
    // numeric user id (`approval.requestedUser !== user.id`) — which never
    // matched, so every Approve click in the chat card and the inbox answered
    // "You do not have access to this approval." depth 0 keeps it the id
    // `ApprovalDoc` already promises.
    depth: 0,
    overrideAccess: true,
  })
  return (result.docs[0] as ApprovalDoc | undefined) ?? null
}

export async function getApproval(id: number) {
  const payload = await getPayloadClient()
  try {
    const doc = await payload.findByID({
      collection: 'approvals',
      id,
      // Same reason as getApprovalByExternalId: callers compare
      // `requestedUser` to a numeric id.
      depth: 0,
      overrideAccess: true,
    })
    return doc as ApprovalDoc | null
  } catch {
    return null
  }
}

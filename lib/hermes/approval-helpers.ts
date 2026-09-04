import { getPayloadClient } from '@/lib/payload'
import { getBrokerPool } from '@/lib/broker/db'
import { subscribeToNotifications } from '@/lib/broker/notify'
import { bestEffort } from '@/lib/failures'
import { logger } from '@/lib/logger'
import type { ApprovalOption, ApprovalStatus } from '@/collections/Approvals'
import type { ApprovalOutcome } from '@/lib/run-events'

/**
 * A parked turn is woken by three things, in descending order of speed.
 *
 * THE PROBLEM THIS SHAPE SOLVES. `pendingApprovalWaiters` below is an
 * in-process `Map`, and until now it was the ONLY way a waiter learned its
 * answer. That worked by coincidence: the dispatcher happens to run inside the
 * Next process today, so the `/api/approvals` POST that settles a request lands
 * in the same heap as the turn that is waiting for it. Nothing enforces that —
 * the dispatcher is meant to be able to run as its own process, and the
 * connector flow made the coincidence untenable on its own, because there the
 * waiter lives in an MCP route handler and the decision arrives on a THIRD
 * request (an OAuth callback) that no load balancer is obliged to send to the
 * same instance. In every one of those arrangements the map is simply absent
 * where the decision lands, and the turn hangs until it times out.
 *
 * So the wait now races three sources and takes whichever answers first:
 *
 *   1. the in-process map, kept because when the decision IS local it is the
 *      only path that costs nothing at all — no network, no round trip (D0);
 *   2. a Postgres NOTIFY on `approval_decisions`, which is what makes a
 *      decision in ANOTHER process reach this waiter, and is the mechanism the
 *      whole change is for;
 *   3. a slow poll of the row itself, because a LISTEN connection can drop
 *      (`lib/broker/notify.ts` reconnects, but a notification sent while it
 *      was down is gone for good) and a run that hangs for its full timeout
 *      after somebody clicked Approve is indistinguishable, to the person who
 *      clicked, from the feature being broken.
 *
 * Nothing here can settle twice in a way that matters: they all resolve one
 * promise, and a promise takes the first answer.
 */
const pendingApprovalWaiters = new Map<
  string,
  {
    resolve: (outcome: ApprovalOutcome) => void
    reject: (err: Error) => void
  }
>()

/** The channel a settled approval is announced on, so a waiter in a different
 * process finds out. Sent from `resolveApproval`, consumed by
 * `waitForApproval`, and registered on the one shared LISTEN connection
 * `lib/broker/notify.ts` already maintains. */
export const APPROVAL_DECISIONS_CHANNEL = 'approval_decisions'

/** How often a parked turn re-reads its own row as a safety net. Deliberately
 * the same order as the SSE route's `FALLBACK_POLL_INTERVAL_MS`: this is the
 * path that must never be the fast one, and one query every ten seconds per
 * PARKED run — not per run, and not per viewer — is a rounding error against
 * a wait measured in minutes. */
const DECISION_POLL_INTERVAL_MS = 10_000

interface DecisionNotice {
  externalId: string
  approved: boolean
  selectedOptionId?: string | null
  reason?: string | null
}

/**
 * One decision, one outcome — used by all three wake-up paths so they cannot
 * disagree about what "approved with no option chosen" means.
 *
 * It means DENIED, which looks surprising and is the pre-existing rule: ACP's
 * `outcome: 'selected'` carries an `optionId`, and inventing one the agent
 * never offered would answer a question that was not asked.
 */
function outcomeFor(decision: {
  approved: boolean
  selectedOptionId?: string | null
  reason?: string | null
}): ApprovalOutcome {
  if (decision.approved && decision.selectedOptionId) {
    return { outcome: 'selected', optionId: decision.selectedOptionId }
  }
  return { outcome: 'cancelled', reason: decision.reason ?? 'denied' }
}

function parseDecisionNotice(payload: string): DecisionNotice | null {
  try {
    const parsed = JSON.parse(payload) as DecisionNotice
    return typeof parsed?.externalId === 'string' ? parsed : null
  } catch {
    // The poll is the fallback. A malformed payload is a bug worth a line in
    // the log, not a reason to fail a turn that is otherwise fine.
    logger.warn('ignoring a malformed approval decision notification', { channel: APPROVAL_DECISIONS_CHANNEL })
    return null
  }
}

/** The row's own answer, for the poll. Null while it is still pending, and
 * null on any read failure — a transient database blip must leave the wait
 * exactly as it was rather than settling it. */
async function readSettledOutcome(externalId: string): Promise<ApprovalOutcome | null> {
  try {
    const payload = await getPayloadClient()
    const {
      docs: [row],
    } = await payload.find({
      collection: 'approvals',
      where: { externalId: { equals: externalId } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    const status = (row as ApprovalDoc | undefined)?.status
    if (!status || status === 'pending') return null
    return outcomeFor({
      approved: status === 'approved',
      selectedOptionId: (row as ApprovalDoc).selectedOptionId,
      reason: status === 'timeout' ? 'timeout' : 'denied',
    })
  } catch {
    return null
  }
}

/** Tells every other process that this request has been answered. Best-effort
 * on purpose: the caller has already committed the decision to the database,
 * and the poll above reaches the same conclusion within ten seconds, so a
 * failure to announce must never turn a successful Approve into an error the
 * person who clicked it has to read. */
async function announceDecision(notice: DecisionNotice): Promise<void> {
  await bestEffort(
    getBrokerPool().query('SELECT pg_notify($1, $2)', [APPROVAL_DECISIONS_CHANNEL, JSON.stringify(notice)]),
    'the decision is already committed and every waiter also polls; a lost wake-up costs latency, not correctness',
    { externalId: notice.externalId },
  )
}

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

  // One promise, settled by whichever of the three sources answers first (see
  // the note on `pendingApprovalWaiters`). `settle` is assigned synchronously
  // inside the executor, so it is defined before anything can call it.
  let settle!: (outcome: ApprovalOutcome) => void
  const settled = new Promise<ApprovalOutcome>((resolve, reject) => {
    settle = resolve
    pendingApprovalWaiters.set(externalId, { resolve, reject })
  })

  // Subscribed BEFORE the timers and before any await that could let a
  // decision land unobserved: a fast human answering a request the instant it
  // appears is a normal case, not a rare one.
  const unsubscribe = await subscribeToNotifications(APPROVAL_DECISIONS_CHANNEL, (payload) => {
    const notice = parseDecisionNotice(payload)
    if (notice && notice.externalId === externalId) settle(outcomeFor(notice))
  })

  const pollHandle = setInterval(() => {
    void readSettledOutcome(externalId).then((outcome) => {
      if (outcome) settle(outcome)
    })
  }, DECISION_POLL_INTERVAL_MS)
  // The timeout below is what decides how long this process stays alive for a
  // parked turn; a redundant safety-net poll must not extend that on its own.
  pollHandle.unref()

  const timeoutHandle = setTimeout(() => settle({ outcome: 'cancelled', reason: 'timeout' }), timeoutMs)

  try {
    const outcome = await settled
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
    clearTimeout(timeoutHandle)
    clearInterval(pollHandle)
    unsubscribe()
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

  const notice: DecisionNotice = {
    externalId,
    approved: decision.approved,
    selectedOptionId: decision.selectedOptionId ?? null,
    reason: decision.reason ?? null,
  }

  // The local waiter first, because when it exists it is free and instant.
  const waiter = pendingApprovalWaiters.get(externalId)
  if (waiter) waiter.resolve(outcomeFor(notice))

  // And then everywhere else, unconditionally — including when a local waiter
  // was found. "There is a waiter here" says nothing about whether the run
  // that is actually parked is here too: a stale entry, or a second process
  // holding the real turn, both look identical from this side.
  await announceDecision(notice)
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

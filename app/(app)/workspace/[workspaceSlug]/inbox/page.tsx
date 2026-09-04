import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { hrefForEntity } from '@/lib/entity-links.server'
import { listPendingApprovalsForUser, type ApprovalDoc } from '@/lib/hermes/approval-helpers'
import { getRun, listFailedRuns, listReviewReadyRuns, listUserMentions } from '@/lib/broker'
import type { Run, UserMention } from '@/lib/broker'
import type { Activity, Notification } from '@/payload-types'
import { type InboxItem } from '@/components/inbox/inbox-list'
import { InboxWorkspace } from '@/components/inbox/inbox-workspace'

// ROADMAP B5.2 (Batch B-5 "Attention") — the Inbox home screen, rebuilt to
// meet the plan's own bar: "Chronological, keyboard-navigable, dismissible,
// zero-able — an email client, not a filtered board." P5.5's original
// version (see git history) grouped items into four always-visible
// sections, which is exactly the "filtered board" shape the plan calls out
// as wrong. This version fetches the same four underlying sources —
// pending approvals, failed runs, review-ready runs, and mentions — but
// merges them into ONE time-ordered list; each row still shows its type via
// an icon (rendered client-side by InboxList), but there are no section
// boundaries a user has to scan past.
//
// Mentions now read the `notifications` collection (filtered to `user` +
// `isRead: false`, matching the bell) instead of querying `activity`
// directly with no user scoping at all — the old query showed literally
// every mention-shaped activity row in the system to every user, which was
// a real bug, not a deliberate simplification. Still honestly empty today:
// no producer anywhere in this codebase emits a `mention`-shaped `action`
// yet (confirmed via a repo-wide grep), so this section lights up the
// moment one does, exactly as the prior version's comment already promised.
//
// Dismissal ("zero-able") differs by item kind, per the plan's own framing:
//   - approval    — already resolved once answered (approve/deny); it simply
//                    stops being 'pending' and drops out of the next fetch.
//   - failed_run / review_run — a run has no prior "acknowledged" concept
//                    (checked lib/broker/types.ts before assuming one), so
//                    this batch adds `runs.dismissed_at` (a real column,
//                    written as lib/broker/migrations/0006_run_dismissed_at.sql,
//                    NOT applied — same discipline as every other schema
//                    change this session) and both broker queries below now
//                    filter it out.
//   - mention     — dismissed by marking its backing notification read,
//                    exactly like opening it does (both call
//                    dismissMentionInbox/markNotificationsRead).
//   - channel_mention — see below.
//
// CHANNEL MENTIONS (this unit). The product used to land a person on a channel
// LIST, which answers "which rooms exist" — a question nobody actually opens a
// product with. "What needs me" is answered here, and cross-channel mentions
// belong in this list rather than in a fourth attention surface beside
// approvals and notifications. So they are NOT a new section: they are a new
// `kind` in the same time-ordered stream, with the same badge/row shape and
// the same j/k/enter/e keys, because a section boundary is the "filtered
// board" shape this page's own header calls out as wrong.
//
// The data is `lib/broker`'s `listUserMentions`: ONE query over the GIN index
// on `team_messages.mentions`, joined to the reader's own slots, scoped to
// this workspace and bounded. No new table, no poll, no second notifications
// store — and crucially no per-row follow-up query, since the row already
// carries the channel name and the sender's display name (which is exactly
// why that function returns them). The Payload-notification `mention` kind
// above stays as it is: it covers @-mentions inside documents, a different
// producer entirely, and collapsing the two would mean losing the channel
// deep-link.
/** Bounded, per D0: this is a landing surface, and "what needs me" is a recent
 * question. Matches the 25 the run queries above use so no one source can
 * crowd the others out of the merged list. */
const CHANNEL_MENTION_LIMIT = 25

export default async function InboxPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const payload = await getPayloadClient()
  const currentUser = await getCurrentPayloadUser()
  const userId = currentUser?.id ?? null

  const [approvals, failedRuns, reviewRuns, channelMentions] = userId
    ? await Promise.all([
        listPendingApprovalsForUser(userId).catch(() => []),
        listFailedRuns(userId, 25),
        listReviewReadyRuns(userId, 25),
        // `userId` is the SERVER-resolved session user, never anything off the
        // wire, and `workspaceId` scopes it to the workspace this route already
        // resolved. listUserMentions additionally joins team_members on
        // user_id, so a caller can only ever see mentions of slots they hold.
        // `unreadOnly` because the Inbox is what needs you, not an archive.
        listUserMentions(userId, {
          workspaceId: workspace.id,
          limit: CHANNEL_MENTION_LIMIT,
          unreadOnly: true,
        }),
      ])
    : [[], [], [], []]

  const mentionNotifications = userId
    ? (
        await payload.find({
          collection: 'notifications',
          where: { user: { equals: userId }, isRead: { equals: false } },
          sort: '-createdAt',
          limit: 50,
          depth: 1,
          overrideAccess: true,
        })
      ).docs.filter((n) => {
        const activity = typeof n.activity === 'object' && n.activity ? n.activity : null
        return Boolean(activity?.action?.toLowerCase().includes('mention'))
      })
    : []

  const [approvalItems, failedItems, reviewItems, mentionItems] = await Promise.all([
    Promise.all(approvals.map((approval) => approvalToItem(payload, approval))),
    Promise.all(failedRuns.map((run) => runToItem(payload, run, 'failed_run'))),
    Promise.all(reviewRuns.map((run) => runToItem(payload, run, 'review_run'))),
    Promise.all(mentionNotifications.map((n) => mentionToItem(payload, n))),
  ])

  // Synchronous: every field a channel-mention row renders is already on the
  // row listUserMentions returned. Mapping it inside the Promise.all above
  // would suggest an await that does not exist.
  // Keyed by message id, because `listUserMentions` joins the reader's slots
  // and returns one row per (message, slot). Nothing in the roster UI lets one
  // person hold two slots in one channel, but `addSlotAction` has no
  // server-side dedupe on `user_id`, so the pair is reachable — and it would
  // land here as two rows sharing a React key and a `channelMessageId`.
  const channelMentionItems = [
    ...new Map(
      channelMentions.map((m) => [m.messageId, channelMentionToItem(m, workspaceSlug)] as const),
    ).values(),
  ]

  const items: InboxItem[] = [
    ...approvalItems,
    ...failedItems,
    ...reviewItems,
    ...mentionItems,
    ...channelMentionItems,
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex w-full shrink-0 flex-col gap-4 px-5 pt-8 pb-4">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Inbox</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {items.length === 0
                ? `Nothing waiting in ${workspace.name}.`
                : `${items.length} item${items.length === 1 ? '' : 's'} need you across ${workspace.name} — newest first.`}
            </p>
            {/* The list already registers these; nothing told anyone they
                existed. */}
            {items.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                <kbd className="rounded border border-black/10 px-1 dark:border-white/15">j</kbd>/
                <kbd className="rounded border border-black/10 px-1 dark:border-white/15">k</kbd> to move ·{' '}
                <kbd className="rounded border border-black/10 px-1 dark:border-white/15">y</kbd> approve ·{' '}
                <kbd className="rounded border border-black/10 px-1 dark:border-white/15">n</kbd> deny ·{' '}
                <kbd className="rounded border border-black/10 px-1 dark:border-white/15">e</kbd> dismiss
              </p>
            )}
          </div>
          {/* A plain anchor here forced a full document reload out of an app
              that is otherwise entirely client-navigated. */}
          <Link href="/settings/notifications" className="mt-1 shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline">
            Notification settings
          </Link>
        </header>
      </div>

      {/* R14-P0.9 — the split pane. The list stays on the left; the right
          pane renders whichever row is selected, in place, with no
          navigation. See `InboxWorkspace` for why the list and its preview
          share one piece of state rather than two. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-8">
        <InboxWorkspace items={items} workspaceSlug={workspaceSlug} />
      </div>
    </div>
  )
}

async function approvalToItem(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  approval: ApprovalDoc,
): Promise<InboxItem> {
  const href = await taskForApprovalHref(payload, approval)
  const options =
    approval.options.length > 0
      ? approval.options.map((o) => o.label ?? o.optionId).join(' · ')
      : null
  return {
    id: `approval-${approval.id}`,
    kind: 'approval',
    headline: approval.title || 'Approval request',
    subline: approval.detail || options || 'An agent needs your approval to act.',
    time: approval.createdAt,
    href,
    approvalId: approval.id,
    approvalOptions: approval.options,
    // R14-P0.9 — the detail pane's `PermissionCard` needs the ACP request id
    // to decide, not the `approvals` row's own numeric id. See
    // `inbox-list.tsx`'s field comment for why the two cannot be folded
    // into one.
    externalId: approval.externalId,
  }
}

async function taskForApprovalHref(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  approval: ApprovalDoc,
): Promise<string | null> {
  if (approval.runId == null) return null
  const run = await getRun(approval.runId)
  if (!run || run.taskId == null) return null
  return hrefForEntity(payload, 'task', String(run.taskId))
}

async function runToItem(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  run: Run,
  kind: 'failed_run' | 'review_run',
): Promise<InboxItem> {
  const href = await taskOrNullHref(payload, run)
  const subline =
    kind === 'failed_run'
      ? run.error || `Run ${run.id} ended in failure`
      : `Run ${run.id} — files changed, ready for review`
  return {
    id: `run-${kind}-${run.id}`,
    kind,
    headline: `Run ${run.id}: ${run.status}`,
    subline,
    time: run.completedAt || run.updatedAt,
    href,
    runId: run.id,
    canRetry: kind === 'failed_run' && run.agentId != null,
    // R14-P0.9 — lets the detail pane offer "See full run" with no extra
    // fetch: this `Run` row already carries it.
    sessionId: run.sessionId,
  }
}

async function taskOrNullHref(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  run: { taskId: number | null },
): Promise<string | null> {
  if (run.taskId == null) return null
  return hrefForEntity(payload, 'task', String(run.taskId))
}

async function mentionToItem(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  notification: Notification,
): Promise<InboxItem> {
  const activity: Activity | null = typeof notification.activity === 'object' ? notification.activity : null
  const actor = activity && typeof activity.actor === 'object' && activity.actor ? activity.actor : null
  const href = activity ? await hrefForEntity(payload, activity.entityType, activity.entityId) : null
  return {
    id: `mention-${notification.id}`,
    kind: 'mention',
    headline: `${actor?.name || actor?.email || 'Someone'} ${activity?.action ?? 'mentioned you'}`,
    subline: activity ? `Mentioned you on a ${activity.entityType}` : notification.message || 'You were mentioned.',
    time: notification.createdAt,
    href,
    notificationId: notification.id,
  }
}

/**
 * A channel mention as an Inbox row.
 *
 * The link goes to the channel, NOT to the thread, even when the mention is a
 * threaded reply. `app/(app)/workspace/[workspaceSlug]/teams/[teamId]/page.tsx`
 * and `components/teams/team-room.tsx` read exactly one deep-link parameter
 * today — `?view=` — and the thread pane opens only from client state
 * (`openThread`). Sending a `?thread=` the room ignores would be a link that
 * looks like it works and does not, so this ships the honest destination and
 * the room-owning unit is told which parameter to accept (see this unit's
 * report). Once the room reads it, this is a one-line change here.
 */
function channelMentionToItem(mention: UserMention, workspaceSlug: string): InboxItem {
  // A threaded mention SAYS it is threaded. The feed this link lands on renders
  // roots only, so for a reply the message you were named in is not on the
  // page you arrive at — you have to open the thread it lives under. That is
  // the honest cost of the channel-level link above, and a row that stayed
  // silent about it would be the "looks like it works and doesn't" failure
  // this function's own note refuses to ship, just arriving one hop later.
  const inThread = mention.threadRootId != null
  return {
    id: `channel-mention-${mention.messageId}`,
    kind: 'channel_mention',
    headline: `${mention.fromDisplayName || 'Someone'} mentioned you in ${
      inThread ? `a thread in #${mention.channelName}` : `#${mention.channelName}`
    }`,
    subline: previewBody(mention.body),
    time: mention.createdAt,
    href: `/workspace/${workspaceSlug}/teams/${mention.teamId}`,
    channelMessageId: mention.messageId,
    // R14-P0.9 — drives the row's and the detail pane's relationship label
    // ("Thread in #general" / "Mentioned in #eng"), structured rather than
    // re-parsed out of `headline`'s free text.
    channelName: mention.channelName,
    inThread,
  }
}

/** One line, and a bounded one. The row is a single truncated line of CSS, so
 * shipping a 40KB message body to the client to render 60 characters of it is
 * payload nobody sees — and a message with newlines would otherwise collapse
 * into a run-on anyway. */
function previewBody(body: string): string | null {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return null
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat
}

// ROADMAP B5.3 (Batch B-5 "Attention") — "an optional email digest." Grepped
// this repo first for any existing email-sending infrastructure
// (nodemailer/resend/sendgrid/smtp) — found none. Per this batch's own
// scoping instructions, that makes full send+schedule out of honest reach
// here (picking and wiring a transactional-email provider is real,
// separate infrastructure work, not something to fabricate). What IS real
// and shipped in this file: the digest QUERY — exactly what would go in a
// user's digest right now, computed against the live broker/approvals
// data, callable and correct today.
//
// What's still a gap, explicitly, not silently:
//   1. No email provider is wired up (no nodemailer/resend/sendgrid client
//      exists in this repo to hand this data to).
//   2. No scheduler calls this on a cadence (a daily cron/queue job that
//      iterates users with `emailDigestEnabled` and calls
//      `getDigestForUser` per user, then sends the result, doesn't exist).
//   3. "Since last digest" is approximated by a rolling time window
//      (`windowHours`, default 24) rather than a tracked "last sent at"
//      timestamp, since no digest has ever actually been sent yet to track
//      that against — once sending exists, the natural next step is a
//      `lastDigestSentAt` column (Users or NotificationPreferences) and
//      swapping this function's window for "since that timestamp."
import { getBrokerPool } from '@/lib/broker'
import type { RunStatus } from '@/lib/broker'
import { listPendingApprovalsForUser, type ApprovalDoc } from '@/lib/hermes/approval-helpers'

export interface DigestRun {
  id: number
  taskId: number | null
  status: RunStatus
  completedAt: string | null
}

export interface DigestData {
  userId: number
  windowHours: number
  pendingApprovals: ApprovalDoc[]
  completedRuns: DigestRun[]
  failedRuns: DigestRun[]
}

interface DigestRunRow {
  id: string | number
  task_id: string | number | null
  status: RunStatus
  completed_at: Date | null
}

/** Everything that would go in `userId`'s digest right now: every pending
 * approval (no time window — a pending approval is always "still relevant"
 * until answered, unlike a completion), plus every completed/failed run in
 * the trailing `windowHours` hours attributed to them. Real, live data —
 * see this file's header comment for what's honestly still missing
 * (sending it anywhere). */
export async function getDigestForUser(userId: number, windowHours = 24): Promise<DigestData> {
  const pendingApprovals = await listPendingApprovalsForUser(userId)

  const pool = getBrokerPool()
  const res = await pool.query<DigestRunRow>(
    `SELECT id, task_id, status, completed_at FROM runs
     WHERE (accountable_user = $1 OR originator_user = $1)
       AND status IN ('completed', 'failed')
       AND completed_at IS NOT NULL
       AND completed_at > now() - ($2::text || ' hours')::interval
     ORDER BY completed_at DESC`,
    [userId, windowHours],
  )

  const runs: DigestRun[] = res.rows.map((row) => ({
    id: Number(row.id),
    taskId: row.task_id === null ? null : Number(row.task_id),
    status: row.status,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  }))

  return {
    userId,
    windowHours,
    pendingApprovals,
    completedRuns: runs.filter((r) => r.status === 'completed'),
    failedRuns: runs.filter((r) => r.status === 'failed'),
  }
}

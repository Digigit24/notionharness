// R5.3 — line-anchored review comments, and the single prompt they compose
// into.
//
// The whole value of this file is the batching. One comment per round trip to
// the agent means a dozen think/edit/verify cycles for one review, each paying
// full model latency and each seeing only its own remark — so fix #7 can undo
// fix #2 and nobody notices until the next read. Comments therefore accumulate
// as rows, and `composeReviewPrompt` turns the whole open set into ONE message:
// one round of thinking, one revision pass, every remark visible to the model
// at the same time.
//
// They persist after sending (status flips to 'sent', nothing is deleted) for
// the other half of that: the point of a review comment is to be checked
// against the result, which is impossible if pressing send erases what you
// asked for.
import { getBrokerPool } from './broker/db'

export type ReviewCommentSide = 'old' | 'new'
export type ReviewCommentStatus = 'open' | 'sent'

export interface ReviewComment {
  id: number
  runId: number
  filePath: string
  side: ReviewCommentSide
  lineNumber: number
  body: string
  /** The source line as it read when the comment was written — see the
   * migration for why this is denormalised rather than re-read on demand. */
  lineContent: string | null
  authorUserId: number | null
  status: ReviewCommentStatus
  sentRunId: number | null
  sentAt: string | null
  createdAt: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toComment(row: any): ReviewComment {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    filePath: row.file_path,
    side: row.side,
    lineNumber: Number(row.line_number),
    body: row.body,
    lineContent: row.line_content ?? null,
    authorUserId: row.author_user_id == null ? null : Number(row.author_user_id),
    status: row.status,
    sentRunId: row.sent_run_id == null ? null : Number(row.sent_run_id),
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Every comment on a run, open and already-sent, in the order the viewer
 * renders them. One query for the whole page — the review surface loads this
 * server-side alongside the file list so the diff arrives with its annotations
 * already on it, rather than painting and then filling in. */
export async function listReviewComments(runId: number): Promise<ReviewComment[]> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `SELECT * FROM review_comments WHERE run_id = $1 ORDER BY file_path, line_number, id`,
    [runId],
  )
  return rows.map(toComment)
}

export async function addReviewComment(input: {
  runId: number
  filePath: string
  side: ReviewCommentSide
  lineNumber: number
  body: string
  lineContent?: string | null
  authorUserId?: number | null
}): Promise<ReviewComment> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `INSERT INTO review_comments (run_id, file_path, side, line_number, body, line_content, author_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      input.runId,
      input.filePath,
      input.side,
      input.lineNumber,
      input.body,
      input.lineContent ?? null,
      input.authorUserId ?? null,
    ],
  )
  return toComment(rows[0])
}

/** Deleting is scoped by run id as well as comment id so a stray id from a
 * client can't reach into another run's review. */
export async function deleteReviewComment(runId: number, id: number): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(`DELETE FROM review_comments WHERE id = $1 AND run_id = $2`, [id, runId])
}

export async function listOpenReviewComments(runId: number): Promise<ReviewComment[]> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `SELECT * FROM review_comments WHERE run_id = $1 AND status = 'open' ORDER BY file_path, line_number, id`,
    [runId],
  )
  return rows.map(toComment)
}

/** Flip a batch to 'sent' in one statement — `= ANY($1)` rather than a loop,
 * so a fifteen-comment review is one round trip against a pool with three
 * connections (lib/broker/db.ts explains how little headroom there is). */
export async function markReviewCommentsSent(ids: number[], sentRunId: number | null): Promise<void> {
  if (ids.length === 0) return
  const pool = getBrokerPool()
  await pool.query(
    `UPDATE review_comments SET status = 'sent', sent_run_id = $2, sent_at = now() WHERE id = ANY($1::bigint[])`,
    [ids, sentRunId],
  )
}

/**
 * The batching itself: N line comments become one prompt.
 *
 * Shape decisions, all of them about being unambiguous to a model reading it
 * cold:
 * - Every remark is numbered and headed `path:line (side)`, so the model can
 *   restate which one it is answering and a human can check the mapping.
 * - The source line is quoted underneath when we captured it. Line numbers
 *   drift the moment the first edit lands; the quoted text is what keeps the
 *   later remarks in the batch resolvable.
 * - The instruction to do all of them in one pass is explicit. Without it the
 *   usual behaviour is to fix the first, report back, and wait — which is
 *   exactly the dozen-round-trip loop this feature exists to remove.
 */
export function composeReviewPrompt(input: {
  runId: number
  comments: ReviewComment[]
  /** Free-text note from the review bar, appended after the line comments. */
  note?: string | null
  branch?: string | null
}): string {
  const { comments } = input
  const parts: string[] = []

  parts.push(
    `Code review of run #${input.runId}${input.branch ? ` (branch \`${input.branch}\`)` : ''}: ${comments.length} line ${
      comments.length === 1 ? 'comment' : 'comments'
    } below.`,
  )
  parts.push(
    'Address all of them in a single revision pass. Do not stop to confirm between them, and do not reply until every comment has been handled — say briefly what you changed for each numbered item at the end.',
  )

  comments.forEach((comment, index) => {
    const lines: string[] = [
      `${index + 1}. ${comment.filePath}:${comment.lineNumber} (${comment.side === 'old' ? 'removed/base side' : 'new side'})`,
    ]
    if (comment.lineContent && comment.lineContent.trim()) {
      // Fenced rather than `>`-quoted: the captured line is code and may
      // itself start with `>`, `-` or `#`, any of which would be re-read as
      // markdown structure and change what the model thinks the line says.
      lines.push('```')
      lines.push(comment.lineContent.replace(/\s+$/, ''))
      lines.push('```')
    }
    // The remark itself IS prose, and is quoted so a multi-paragraph comment
    // can never be mistaken for the next numbered item.
    for (const line of comment.body.split('\n')) lines.push(`> ${line}`)
    parts.push(lines.join('\n'))
  })

  const note = input.note?.trim()
  if (note) parts.push(`Additional note:\n${note}`)

  return parts.join('\n\n')
}

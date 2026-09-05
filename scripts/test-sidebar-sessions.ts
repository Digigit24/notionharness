// The sidebar's Sessions section — `SessionListItem.needsAttention`.
//
// The one property worth proving against real rows: `needsAttention` reads
// the session's NEWEST run only. A session whose most recent run succeeded
// must not stay flagged just because an EARLIER attempt failed — that would
// make a "needs attention" list one that never empties for a session anyone
// simply retried and moved on from, which defeats the point of the highlight.
//
//   npx tsx scripts/test-sidebar-sessions.ts
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { enqueueRun } = await import('../lib/broker/runs')
const { createSession, listSessions } = await import('../lib/broker/sessions')
const { getBrokerPool, closeBrokerPool } = await import('../lib/broker/db')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const pool = getBrokerPool()
const agentRow = await pool.query<{ id: number; workspace_id: number }>(
  `SELECT id, workspace_id FROM agents WHERE enabled = true ORDER BY id LIMIT 1`,
)
if (agentRow.rows.length === 0) throw new Error('No enabled agent to build a fixture with.')
const { id: agentId, workspace_id: workspaceId } = agentRow.rows[0]
const userRow = await pool.query<{ id: number }>('SELECT id FROM users ORDER BY id LIMIT 1')
const userId = userRow.rows[0].id

const sessionIds: number[] = []
try {
  // Newest run failed — the highlighted case.
  const failedSession = await createSession({ workspaceId, agentId, createdBy: userId, title: 'failed' })
  sessionIds.push(failedSession.id)
  const failedRun = await enqueueRun({ accountableUser: userId, agentId, sessionId: failedSession.id, prompt: 'x' })
  await pool.query(`UPDATE runs SET status = 'failed', completed_at = now() WHERE id = $1`, [failedRun.id])

  // Failed, then retried and succeeded — must NOT stay flagged.
  const recoveredSession = await createSession({ workspaceId, agentId, createdBy: userId, title: 'recovered' })
  sessionIds.push(recoveredSession.id)
  const firstAttempt = await enqueueRun({ accountableUser: userId, agentId, sessionId: recoveredSession.id, prompt: 'x' })
  await pool.query(`UPDATE runs SET status = 'failed', completed_at = now() WHERE id = $1`, [firstAttempt.id])
  const retry = await enqueueRun({ accountableUser: userId, agentId, sessionId: recoveredSession.id, prompt: 'x' })
  await pool.query(`UPDATE runs SET status = 'completed', completed_at = now() WHERE id = $1`, [retry.id])

  // No runs at all — must not be flagged just for being new.
  const freshSession = await createSession({ workspaceId, agentId, createdBy: userId, title: 'fresh' })
  sessionIds.push(freshSession.id)

  const rows = await listSessions({ workspaceId, sessionIds, includeArchived: true })
  const byId = new Map(rows.map((r) => [r.id, r]))

  check('a session whose newest run failed is flagged', byId.get(failedSession.id)?.needsAttention === true)
  check(
    'a session that failed then succeeded on retry is NOT flagged — only the newest run counts',
    byId.get(recoveredSession.id)?.needsAttention === false,
  )
  check('a session with no runs at all is not flagged', byId.get(freshSession.id)?.needsAttention === false)
} finally {
  if (sessionIds.length > 0) {
    await pool.query('DELETE FROM runs WHERE session_id = ANY($1)', [sessionIds]).catch(() => undefined)
    await pool.query('DELETE FROM chat_sessions WHERE id = ANY($1)', [sessionIds]).catch(() => undefined)
  }
  await closeBrokerPool()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

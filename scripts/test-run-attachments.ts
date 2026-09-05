// Work hero composer — file attachments on a run.
//
// Two things this proves, matching this unit's own migration and prompt-text
// comments:
//
//   1. The migration's DDL applied correctly — `runs.attachments` really is
//      jsonb, not-null, defaulted to '[]', and a run enqueued with
//      attachment ids reads them back unchanged through `enqueueRun`/`getRun`
//      (`lib/broker/runs.ts`), the same round trip
//      `scripts/test-media-attachments.ts` already proved for
//      `team_messages.attachments`.
//   2. `formatAttachmentsForPrompt` (`lib/work/attachment-prompt.ts`) — the
//      pure function that turns resolved Media docs into the text actually
//      appended to a run's prompt — produces exactly the filename/URL lines
//      an agent needs to go find the file, and produces nothing at all when
//      there is nothing attached.
//
//   npx tsx scripts/test-run-attachments.ts
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { enqueueRun, getRun } = await import('../lib/broker/runs')
const { createSession, deleteSession } = await import('../lib/broker/sessions')
const { getBrokerPool, closeBrokerPool } = await import('../lib/broker/db')
const { formatAttachmentsForPrompt } = await import('../lib/work/attachment-prompt')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// --- #2 first: pure, no database needed --------------------------------
check(
  'no attachments produces no suffix at all',
  formatAttachmentsForPrompt([]) === '',
)
check(
  'one attachment renders as a labelled, linked line',
  formatAttachmentsForPrompt([{ filename: 'diagram.png', url: '/api/media/9/file' }]) ===
    '\n\nAttached files:\n- diagram.png (/api/media/9/file)',
)
check(
  'several attachments each get their own line, in order',
  formatAttachmentsForPrompt([
    { filename: 'a.png', url: '/api/media/1/file' },
    { filename: 'b.pdf', url: '/api/media/2/file' },
  ]) === '\n\nAttached files:\n- a.png (/api/media/1/file)\n- b.pdf (/api/media/2/file)',
)

// --- #1: the real column, through the real insert/read path -------------
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
  const session = await createSession({ workspaceId, agentId, createdBy: userId, title: 'attachments probe' })
  sessionIds.push(session.id)

  const withAttachments = await enqueueRun({
    accountableUser: userId,
    agentId,
    sessionId: session.id,
    prompt: 'see attached',
    attachments: [101, 202],
  })
  check(
    'enqueueRun stores the attachment ids and returns them immediately',
    JSON.stringify(withAttachments.attachments) === JSON.stringify([101, 202]),
    JSON.stringify(withAttachments.attachments),
  )

  const reread = await getRun(withAttachments.id)
  check(
    'and they survive a fresh read back from the database',
    JSON.stringify(reread?.attachments) === JSON.stringify([101, 202]),
    JSON.stringify(reread?.attachments),
  )

  // `runs_task_agent_active_uidx` allows only one NON-TERMINAL run per
  // (task, agent, page, session) — settle the first before enqueuing a
  // second turn in the same session, same as `test-sidebar-sessions.ts`
  // does for its own retry fixture.
  await pool.query(`UPDATE runs SET status = 'completed', completed_at = now() WHERE id = $1`, [withAttachments.id])

  const withoutAttachments = await enqueueRun({ accountableUser: userId, agentId, sessionId: session.id, prompt: 'no files here' })
  check(
    'a run enqueued with no attachments defaults to [], never null',
    Array.isArray(withoutAttachments.attachments) && withoutAttachments.attachments.length === 0,
    JSON.stringify(withoutAttachments.attachments),
  )

  const { rows: columnCheck } = await pool.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'runs' AND column_name = 'attachments'`,
  )
  check(
    'the column is really jsonb, not-null, defaulted to []',
    columnCheck[0]?.data_type === 'jsonb' &&
      columnCheck[0]?.is_nullable === 'NO' &&
      (columnCheck[0]?.column_default ?? '').includes("'[]'"),
    JSON.stringify(columnCheck[0]),
  )
} finally {
  if (sessionIds.length > 0) {
    await pool.query('DELETE FROM runs WHERE session_id = ANY($1)', [sessionIds]).catch(() => undefined)
    for (const id of sessionIds) await deleteSession(id).catch(() => undefined)
  }
  await closeBrokerPool()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

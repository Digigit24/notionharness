// R14-P0.3 — the channel History tab's own query.
//
// Two properties carry the design and neither is obvious from reading the
// code, so both are exercised against the real database:
//
//   * scope is the CHANNEL'S ROSTER, not the workspace. A slot binds one
//     agent to one `chat_sessions` row, so `listChannelHistorySessionsAction`
//     has to resolve to exactly the sessions its own slots hold — a session
//     belonging to some other team in the same workspace must not leak in.
//   * `latestRunId` is the field the tab actually needs to open a row in the
//     run-detail sheet with no second query. It must be the newest run, and
//     null for a session that was created but never run.
//
//   npx tsx scripts/test-channel-history.ts
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const teams = await import('../lib/broker/teams')
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

let teamId: number | null = null
let otherTeamId: number | null = null
try {
  const team = await teams.createTeam({ workspaceId, name: `history-probe-${Date.now() % 100000}` })
  teamId = team.id

  // A session with a run — the ordinary case a History row represents.
  const ranSession = await createSession({ workspaceId, agentId, createdBy: userId, title: 'ran' })
  const firstRun = await enqueueRun({ accountableUser: userId, agentId, sessionId: ranSession.id, prompt: 'first' })
  // `runs_task_agent_active_uidx` allows only one ACTIVE run per (agent,
  // session) pair — exactly what stops an agent racing itself. Settling the
  // first before enqueueing the second is what a real session actually does;
  // it is not a workaround for the fixture.
  await pool.query(`UPDATE runs SET status = 'completed', completed_at = now() WHERE id = $1`, [firstRun.id])
  const secondRun = await enqueueRun({ accountableUser: userId, agentId, sessionId: ranSession.id, prompt: 'second' })

  // A session bound to a slot but never actually run — latestRunId must read
  // as null, not as some placeholder, so the tab knows to disable the row.
  const neverRanSession = await createSession({ workspaceId, agentId, createdBy: userId, title: 'never ran' })

  await teams.addTeamMember({ teamId: team.id, agentId, displayName: 'Ran', sessionId: ranSession.id })
  await teams.addTeamMember({ teamId: team.id, agentId, displayName: 'NeverRan', sessionId: neverRanSession.id })

  // A session that belongs to a DIFFERENT channel's roster in the same
  // workspace. If this leaks into the first channel's history, the scope
  // this whole action exists to enforce is broken.
  const other = await teams.createTeam({ workspaceId, name: `history-probe-other-${Date.now() % 100000}` })
  otherTeamId = other.id
  const strangerSession = await createSession({ workspaceId, agentId, createdBy: userId, title: 'stranger' })
  await teams.addTeamMember({ teamId: other.id, agentId, displayName: 'Stranger', sessionId: strangerSession.id })

  const roster = await teams.listTeamMembers(team.id)
  const sessionIds = [...new Set(roster.map((m) => m.sessionId).filter((id): id is number => id != null))]
  const history = await listSessions({ workspaceId, sessionIds, includeArchived: true })

  check(
    'the channel only sees its own roster\'s sessions',
    history.length === 2 && history.every((s) => s.id === ranSession.id || s.id === neverRanSession.id),
    `${history.length} rows: ${history.map((s) => s.id).join(',')}`,
  )
  check(
    'and the other channel\'s session does not leak in',
    !history.some((s) => s.id === strangerSession.id),
  )

  const ranRow = history.find((s) => s.id === ranSession.id)
  check('the run-carrying session reports its NEWEST run', ranRow?.latestRunId === secondRun.id, String(ranRow?.latestRunId))

  const neverRanRow = history.find((s) => s.id === neverRanSession.id)
  check('a session with no runs reports latestRunId as null, not 0 or undefined', neverRanRow?.latestRunId === null)

  const empty = await listSessions({ workspaceId, sessionIds: [], includeArchived: true })
  check('an empty sessionIds filter returns no rows rather than every session', empty.length === 0)
} finally {
  if (teamId != null) await teams.deleteTeam(teamId).catch(() => undefined)
  if (otherTeamId != null) await teams.deleteTeam(otherTeamId).catch(() => undefined)
  await closeBrokerPool()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

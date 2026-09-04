// A blocked agent must be visible ON THE CHANNEL, not only in its thread.
//
// The bug: an agent woken by a mention hits a permission request mid-turn and
// goes quiet. The dispatcher announced the block INTO THE THREAD, so out on
// the feed it was a reply count going up and nothing else — the person it was
// waiting on had to open the thread, or find the card in the Inbox, to learn
// anything was waiting on them.
//
// `listPendingChannelApprovals` is what the channel reads. This asserts the
// three properties the UI depends on, against real rows:
//
//   * it is keyed by the thread ROOT, because the feed is roots only. Keyed by
//     the triggering message, a block raised by a reply would render under a
//     row the feed never shows.
//   * it carries the deciding user, because everyone sees the block and only
//     one person may answer it.
//   * it goes away when the approval is answered. A control that outlives its
//     decision is worse than no control.
//
//   npx tsx scripts/test-channel-approvals.ts
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const teams = await import('../lib/broker/teams')
const ch = await import('../lib/broker/channels')
const { enqueueRun } = await import('../lib/broker/runs')
const { createSession } = await import('../lib/broker/sessions')
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
const externalId = `probe-approval-${Date.now()}`
try {
  const team = await teams.createTeam({ workspaceId, name: `approval-probe-${Date.now() % 100000}` })
  teamId = team.id
  const me = await teams.addTeamMember({ teamId: team.id, agentId, displayName: 'Me', role: 'leader' })
  const session = await createSession({ workspaceId, agentId, createdBy: userId, title: 'approval probe' })
  const bot = await teams.addTeamMember({
    teamId: team.id,
    agentId,
    displayName: 'Probe Bot',
    sessionId: session.id,
  })

  // The shape that broke: the agent is named in a REPLY, so the run hangs off
  // a message the feed does not render.
  const root = await ch.postChannelMessage({ teamId: team.id, fromSlotId: me.id, body: 'Kick off the migration.' })
  const trigger = await ch.postChannelMessage({
    teamId: team.id,
    fromSlotId: me.id,
    body: '@Probe Bot take it from here',
    threadRootId: root.id,
  })

  const run = await enqueueRun({
    agentId,
    sessionId: session.id,
    originatorUser: userId,
    accountableUser: userId,
    prompt: 'probe',
    channelMessageId: trigger.id,
  })

  // Written directly rather than through Payload: this is asserting what the
  // channel query READS, and going through the collection would test Payload.
  await pool.query(
    `INSERT INTO approvals (run_id, external_id, requested_user_id, title, detail, options, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', now(), now())`,
    [
      run.id,
      externalId,
      userId,
      'run `rm -rf build`',
      'in E:/repo',
      JSON.stringify([
        { optionId: 'allow', kind: 'allow_once', label: 'Allow once' },
        { optionId: 'reject', kind: 'reject_once', label: 'Deny' },
      ]),
    ],
  )

  const found = await ch.listPendingChannelApprovals(team.id)
  const mine = found.find((row) => row.externalId === externalId)
  check('a blocked run surfaces on the channel', mine != null, `${found.length} rows`)
  check(
    'keyed by the thread ROOT, which is the row the feed actually shows',
    mine?.rootMessageId === root.id,
    `${mine?.rootMessageId} vs root ${root.id}`,
  )
  check('and it still names the message that woke the agent', mine?.triggerMessageId === trigger.id)
  check('it names the slot that is blocked', mine?.slotId === bot.id, String(mine?.slotId))
  check('it names who may decide', mine?.requestedUserId === userId, String(mine?.requestedUserId))
  check('with the run to open', mine?.runId === run.id && mine?.sessionId === session.id)
  check('and the options to offer', (mine?.options.length ?? 0) === 2, JSON.stringify(mine?.options))

  // Answered, and gone.
  await pool.query(`UPDATE approvals SET status = 'approved' WHERE external_id = $1`, [externalId])
  const after = await ch.listPendingChannelApprovals(team.id)
  check(
    'a decided request disappears from the channel',
    after.every((row) => row.externalId !== externalId),
    `${after.length} rows still pending`,
  )

  // A channel must never see another channel's blocks.
  const other = await teams.createTeam({ workspaceId, name: `approval-probe-other-${Date.now() % 100000}` })
  await pool.query(`UPDATE approvals SET status = 'pending' WHERE external_id = $1`, [externalId])
  const leaked = await ch.listPendingChannelApprovals(other.id)
  check('and never leaks into another channel', leaked.every((row) => row.externalId !== externalId))
  await teams.deleteTeam(other.id)
} finally {
  await pool.query('DELETE FROM approvals WHERE external_id = $1', [externalId]).catch(() => undefined)
  if (teamId != null) await teams.deleteTeam(teamId).catch(() => undefined)
  await closeBrokerPool()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

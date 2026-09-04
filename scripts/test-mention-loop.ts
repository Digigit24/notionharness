// Does mentioning an agent in a channel actually make it answer?
//
// The reported bug: "@Claude Code" in a channel did nothing — no run, no
// reply, no work assigned to the agent named. `parseMentions` indexed who was
// mentioned and nothing consumed the index.
//
// This exercises the real loop against the real dispatcher: post a message
// naming an agent slot, wait, and then ask the DATABASE whether a run was
// started and whether an answer landed in that message's thread. It asserts on
// rows, never on prose, because an agent that says it replied without replying
// is precisely the failure being hunted.
//
//   npx tsx scripts/test-mention-loop.ts ["Agent Name"]
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const teams = await import('../lib/broker/teams')
const ch = await import('../lib/broker/channels')
const { dispatchMentions } = await import('../lib/teams/mention-dispatch')
const { getRun } = await import('../lib/broker/runs')
const { createSession } = await import('../lib/broker/sessions')
const { getBrokerPool, closeBrokerPool } = await import('../lib/broker/db')

const AGENT_NAME = process.argv[2] ?? 'Claude Code'
const TIMEOUT_MS = 5 * 60_000

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const pool = getBrokerPool()
const agentRow = await pool.query<{ id: number; workspace_id: number }>(
  `SELECT id, workspace_id FROM agents WHERE name = $1 AND enabled = true ORDER BY id LIMIT 1`,
  [AGENT_NAME],
)
if (agentRow.rows.length === 0) throw new Error(`No enabled agent named "${AGENT_NAME}".`)
const { id: agentId, workspace_id: workspaceId } = agentRow.rows[0]
const userRow = await pool.query<{ id: number }>('SELECT id FROM users ORDER BY id LIMIT 1')
const userId = userRow.rows[0].id

let teamId: number | null = null
try {
  const team = await teams.createTeam({ workspaceId, name: `mention-probe-${Date.now() % 100000}` })
  teamId = team.id

  // A human slot for the person speaking, and an agent slot to be mentioned.
  const human = await teams.addTeamMember({ teamId: team.id, agentId, displayName: 'Me', role: 'leader' })
  const agentSession = await createSession({ workspaceId, agentId, createdBy: userId, title: AGENT_NAME })
  const bot = await teams.addTeamMember({
    teamId: team.id,
    agentId,
    displayName: AGENT_NAME,
    sessionId: agentSession.id,
  })
  console.log(`channel ${team.id}: me=${human.id}, ${AGENT_NAME}=${bot.id}`)
  console.log('')

  const roster = (await teams.listTeamMembers(team.id)).map((m) => ({
    id: m.id,
    displayName: m.displayName,
    agentId: m.agentId || null,
    sessionId: m.sessionId,
  }))
  const body = `@${AGENT_NAME} reply with exactly the word MENTION_OK and nothing else.`
  const mentions = ch.parseMentions(body, roster)
  check('the mention resolves to the agent slot', mentions.some((m) => m.id === bot.id), JSON.stringify(mentions))

  const message = await ch.postChannelMessage({
    teamId: team.id,
    fromSlotId: human.id,
    body,
    mentions,
  })

  const dispatch = await dispatchMentions({
    message,
    channelName: team.name,
    roster,
    authorName: 'Me',
    accountableUserId: userId,
  })
  console.log(`dispatched: ${JSON.stringify(dispatch.dispatched)}`)
  console.log(`skipped:    ${JSON.stringify(dispatch.skipped)}`)
  console.log('')
  check('mentioning an agent starts a run', dispatch.dispatched.length === 1, JSON.stringify(dispatch))
  check('and it is the MENTIONED slot that runs, not the author', dispatch.dispatched[0]?.slotId === bot.id)

  // Mentioning again must not start a second run for the same message.
  const again = await dispatchMentions({
    message,
    channelName: team.name,
    roster,
    authorName: 'Me',
    accountableUserId: userId,
  })
  check('a repeat dispatch of one message is refused', again.dispatched.length === 0, JSON.stringify(again.skipped))

  const runId = dispatch.dispatched[0]?.runId
  if (!runId) throw new Error('No run to wait for.')
  console.log(`waiting for run ${runId} (up to ${TIMEOUT_MS / 1000}s)...`)
  const started = Date.now()
  let settled = null
  while (Date.now() - started < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 4000))
    const current = await getRun(runId)
    if (current && ['completed', 'failed', 'cancelled'].includes(current.status)) {
      settled = current
      break
    }
  }
  if (!settled) {
    console.log('FAIL  the run never settled — is the dispatcher loop running?')
    process.exit(1)
  }
  console.log(`run settled: ${settled.status}`)
  check('the run remembers which message it answers', settled.channelMessageId === message.id, String(settled.channelMessageId))

  // The point of the whole exercise: an answer in the thread.
  const thread = await ch.listThread(message.id)
  const replies = thread.filter((m) => m.id !== message.id)
  console.log('')
  for (const reply of replies) {
    console.log(`  reply from slot ${reply.fromSlotId}: ${reply.body.slice(0, 160).replace(/\s+/g, ' ')}`)
  }
  console.log('')
  check('an answer landed in the thread', replies.length > 0, `${replies.length} replies`)
  check('and it came from the mentioned agent', replies.some((r) => r.fromSlotId === bot.id))
  check(
    'exactly one answer, not a double post',
    replies.filter((r) => r.fromSlotId === bot.id).length === 1,
    `${replies.filter((r) => r.fromSlotId === bot.id).length}`,
  )
  check('the feed still shows one root, replies stay in the thread', (await ch.listChannelFeed(team.id)).length === 1)
} finally {
  if (teamId != null) await teams.deleteTeam(teamId).catch(() => undefined)
  await closeBrokerPool()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

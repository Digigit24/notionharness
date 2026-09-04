// Does a leader agent in a team ACTUALLY delegate?
//
// Everything about Teams verified so far is the protocol layer: the MCP tools
// answer correctly when called with synthetic runs. What has never been tested
// is the thing the feature is FOR — a real agent, in a real slot, during a real
// turn, discovering it has team tools and using them.
//
// This builds a real team with a real runtime, sends the leader an objective,
// lets the actual dispatcher run it, and then asks the database what the leader
// did. It asserts on ROWS the leader created, not on what it said, because an
// agent that describes delegating without delegating is the exact failure this
// is looking for.
//
//   npx tsx scripts/test-team-delegation.ts
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

// Deliberately NO Payload client here. This script runs alongside a live
// server that already holds a Payload pool and a broker pool, against a
// 15-connection limit — spinning up a second Payload instance for one lookup
// exhausted it, and the dispatcher's agent lookup then failed in a way that
// looked like a missing agent. Raw pg for the one row this needs.
const b = await import('../lib/broker/teams')
const { enqueueRun, getRun } = await import('../lib/broker/runs')
const { createSession } = await import('../lib/broker/sessions')
const { listRunEvents } = await import('../lib/broker/messages')
const { getBrokerPool, closeBrokerPool } = await import('../lib/broker/db')

const AGENT_NAME = process.argv[2] ?? 'Claude Code'
const TIMEOUT_MS = 5 * 60_000

const pool = getBrokerPool()
const agentRows = await pool.query<{ id: number; workspace_id: number }>(
  `SELECT id, workspace_id FROM agents WHERE name = $1 AND enabled = true ORDER BY id LIMIT 1`,
  [AGENT_NAME],
)
const agent = agentRows.rows[0]
if (!agent) throw new Error(`No enabled agent named "${AGENT_NAME}".`)
const workspaceId = Number(agent.workspace_id)
const user = await pool.query<{ id: number }>('SELECT id FROM users ORDER BY id LIMIT 1')
const userId = user.rows[0].id

let teamId: number | null = null
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

try {
  const team = await b.createTeam({
    workspaceId,
    name: `delegation-probe-${Date.now() % 100000}`,
    workspaceMode: 'per_member',
    createdBy: userId,
  })
  teamId = team.id

  // Each slot gets its own session, exactly as the UI's createSlot does — that
  // session is what binds a run to a slot.
  const leaderSession = await createSession({ workspaceId, agentId: agent.id, createdBy: userId, title: 'Leader' })
  const memberSession = await createSession({ workspaceId, agentId: agent.id, createdBy: userId, title: 'Member' })
  const leader = await b.addTeamMember({
    teamId: team.id,
    agentId: agent.id,
    displayName: 'Lead',
    role: 'leader',
    sessionId: leaderSession.id,
  })
  const member = await b.addTeamMember({
    teamId: team.id,
    agentId: agent.id,
    displayName: 'Builder',
    role: 'member',
    sessionId: memberSession.id,
  })
  console.log(`team ${team.id}: leader slot ${leader.id}, member slot ${member.id}`)
  console.log('')

  const run = await enqueueRun({
    agentId: agent.id,
    sessionId: leaderSession.id,
    originatorUser: userId,
    accountableUser: userId,
    prompt:
      'You are leading a team. Break this objective into exactly two tasks and assign one to your teammate, ' +
      'then tell them what you assigned. Objective: add a health check endpoint and write its tests.',
  })
  console.log(`run ${run.id} queued; waiting for the dispatcher (up to ${TIMEOUT_MS / 1000}s)...`)

  const started = Date.now()
  let settled = null
  while (Date.now() - started < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 4000))
    const current = await getRun(run.id)
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
  console.log('')

  // What the agent SAW. A tool it was never offered cannot be called.
  const events = await listRunEvents(run.id)
  const toolNames = events
    .map((e) => e.event)
    .filter((e): e is Extract<typeof e, { type: 'tool_call' }> => e.type === 'tool_call')
    .map((e) => String((e as { name?: string }).name ?? ''))
  const teamToolCalls = toolNames.filter((n) => n.includes('team_'))
  console.log(`tool calls this turn: ${toolNames.length}`)
  console.log(`team_* tool calls:    ${teamToolCalls.length}${teamToolCalls.length ? ` (${teamToolCalls.join(', ')})` : ''}`)

  const assistantText = events
    .map((e) => e.event)
    .filter((e): e is Extract<typeof e, { type: 'message' }> => e.type === 'message' && e.role === 'assistant')
    .map((e) => e.text)
    .join('')
  console.log('')
  console.log(`leader said: ${assistantText.slice(0, 400).replace(/\s+/g, ' ')}`)
  console.log('')

  // The assertions that matter are about ROWS, not prose.
  const tasks = await b.listTeamTasks(team.id)
  const messages = await b.listTeamMessages(team.id)
  console.log(`team tasks created:    ${tasks.length}`)
  console.log(`team messages sent:    ${messages.length}`)
  console.log('')

  check('the leader called at least one team tool', teamToolCalls.length > 0)
  check('the leader created tasks on the board', tasks.length > 0, `${tasks.length} tasks`)
  check('at least one task is assigned to the member', tasks.some((t) => t.ownerSlotId === member.id))
  check('the leader messaged the team', messages.length > 0, `${messages.length} messages`)
} finally {
  if (teamId != null) await b.deleteTeam(teamId).catch(() => undefined)
  await closeBrokerPool()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

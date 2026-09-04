// R6.1/R6.3 verification.
//
// Two properties carry the design and neither is obvious from reading the
// code, so both are exercised against the real database:
//
//   1. The BOARD is authoritative, not the leader. A task becomes claimable
//      when its dependencies are satisfied, whether or not any leader is
//      alive to notice.
//   2. Two members claiming the same task concurrently cannot both win. The
//      guard is in the UPDATE rather than in a prior read, and idle members
//      polling one board is exactly the situation that would trigger the race.
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const b = await import('../lib/broker/teams')
const { closeBrokerPool } = await import('../lib/broker/db')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

let teamId: number | null = null
try {
  const team = await b.createTeam({ workspaceId: 2, name: `test-team-${Date.now()}`, workspaceMode: 'per_member' })
  teamId = team.id

  const leader = await b.addTeamMember({ teamId: team.id, agentId: 6, displayName: 'Leader', role: 'leader' })
  const alice = await b.addTeamMember({ teamId: team.id, agentId: 6, displayName: 'Alice' })
  const bob = await b.addTeamMember({ teamId: team.id, agentId: 6, displayName: 'Bob' })
  check('a team has members', (await b.listTeamMembers(team.id)).length === 3)
  check('the leader sorts first', (await b.listTeamMembers(team.id))[0].id === leader.id)

  // The same agent twice, as two slots with different jobs.
  check('one agent can hold two slots', alice.agentId === bob.agentId && alice.id !== bob.id)

  // At most one leader, enforced by the database rather than by callers.
  let secondLeaderRejected = false
  try {
    await b.addTeamMember({ teamId: team.id, agentId: 6, displayName: 'Usurper', role: 'leader' })
  } catch {
    secondLeaderRejected = true
  }
  check('a second leader is rejected by the database', secondLeaderRejected)

  await b.setTeamLeader(team.id, alice.id)
  const afterHandover = await b.listTeamMembers(team.id)
  check(
    'leadership can be handed over atomically',
    afterHandover.filter((m) => m.role === 'leader').length === 1 &&
      afterHandover.find((m) => m.role === 'leader')?.id === alice.id,
  )
  await b.setTeamLeader(team.id, leader.id)

  // --- The dependency graph ---
  const first = await b.createTeamTask({ teamId: team.id, subject: 'Write the parser' })
  const second = await b.createTeamTask({ teamId: team.id, subject: 'Use the parser', blockedBy: [first.id] })
  check('a task with unmet dependencies starts blocked', second.status === 'blocked', second.status)
  check('its blocker is recorded as a graph edge', second.blockedBy.includes(first.id), JSON.stringify(second.blockedBy))

  let claimable = await b.claimableTasks(team.id)
  check(
    'only the unblocked task is claimable',
    claimable.length === 1 && claimable[0].id === first.id,
    claimable.map((t) => t.subject).join(', '),
  )

  // --- The race: two members claim the same task at the same moment ---
  const [claimA, claimB] = await Promise.all([
    b.claimTeamTask(first.id, alice.id),
    b.claimTeamTask(first.id, bob.id),
  ])
  const winners = [claimA, claimB].filter(Boolean)
  check('exactly one concurrent claim wins', winners.length === 1, `${winners.length} winners`)
  check('the loser is told it lost, rather than silently sharing', claimA === null || claimB === null)

  // --- Completion releases dependents, and tells the room ---
  const owner = winners[0]?.ownerSlotId ?? alice.id
  const done = await b.reportTeamTaskDone({ taskId: first.id, slotId: owner, summary: 'Parser written.' })
  check('the finished task carries its own result', done.task?.result === 'Parser written.', String(done.task?.result))
  check('finishing releases what it was blocking', done.released.some((t) => t.id === second.id),
    done.released.map((t) => t.subject).join(', '))

  const afterRelease = await b.getTeamTask(second.id)
  check('the released task is no longer blocked', afterRelease?.status === 'open', String(afterRelease?.status))

  // The report reached the room, in the same transaction as the settle.
  const feed = await b.listTeamMessages(team.id)
  check('the completion was reported to the room', feed.some((m) => m.kind === 'report' && m.taskId === first.id))

  // --- The mailbox ---
  await b.sendTeamMessage({ teamId: team.id, fromSlotId: leader.id, toSlotId: bob.id, kind: 'instruction', body: 'Take the next one.' })
  await b.sendTeamMessage({ teamId: team.id, fromSlotId: leader.id, toSlotId: null, kind: 'status', body: 'Standup in 5.' })

  const bobInbox = await b.readTeamInbox({ teamId: team.id, slotId: bob.id })
  check('a direct message reaches its addressee', bobInbox.some((m) => m.body === 'Take the next one.'))
  check('a broadcast reaches everyone', bobInbox.some((m) => m.body === 'Standup in 5.'))

  const aliceInbox = await b.readTeamInbox({ teamId: team.id, slotId: alice.id })
  check("a direct message does NOT reach someone else", !aliceInbox.some((m) => m.body === 'Take the next one.'))
  check(
    'a slot does not receive its own messages back',
    (await b.readTeamInbox({ teamId: team.id, slotId: leader.id })).every((m) => m.fromSlotId !== leader.id),
  )

  // The cursor is an id, so polling cannot skip or repeat.
  const cursor = bobInbox[bobInbox.length - 1]?.id ?? 0
  check('an id cursor returns nothing new when nothing is new',
    (await b.readTeamInbox({ teamId: team.id, slotId: bob.id, since: cursor })).length === 0)

  // --- The leader is not required ---
  await b.removeTeamMember(leader.id)
  const withoutLeader = await b.claimableTasks(team.id)
  check(
    'the board still offers work with no leader at all',
    withoutLeader.some((t) => t.id === second.id),
    withoutLeader.map((t) => t.subject).join(', '),
  )
} finally {
  if (teamId != null) await b.deleteTeam(teamId).catch(() => undefined)
  await closeBrokerPool()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

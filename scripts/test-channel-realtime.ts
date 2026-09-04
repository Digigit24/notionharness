// R12-P3.3/P3.2 — the push transport, proven by actually listening for it.
//
// The obvious way to get this wrong is to add `pg_notify` calls that compile,
// look right, and never fire — a typo'd channel name, a payload shape the
// route does not parse, a call site that got missed. None of that shows up in
// a type check. So this opens a REAL `LISTEN` connection, exactly the way
// `lib/broker/notify.ts` does, and asserts a real notification arrives with
// the right shape, within a timeout, for each of the three write paths that
// are supposed to publish one: a message, a reaction, and a resolved
// approval. It also proves the ONE thing a shared channel can get wrong
// silently — another team's event must never be mistaken for this one's.
//
//   npx tsx scripts/test-channel-realtime.ts
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { Client } = await import('pg')
const teams = await import('../lib/broker/teams')
const ch = await import('../lib/broker/channels')
const { getBrokerPool, closeBrokerPool } = await import('../lib/broker/db')
const { enqueueRun } = await import('../lib/broker/runs')
const { createSession } = await import('../lib/broker/sessions')
const { resolveApproval } = await import('../lib/hermes/approval-helpers')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Waits for the next notification on a channel, or times out. Resolves with
 * every payload seen while waiting, so a caller can assert on ordering or on
 * "not this one" as well as on "the one I wanted". */
function waitForNotification(
  client: InstanceType<typeof Client>,
  channel: string,
  timeoutMs: number,
): { promise: Promise<string[]>; stop: () => void } {
  const seen: string[] = []
  let resolve!: (v: string[]) => void
  const promise = new Promise<string[]>((r) => {
    resolve = r
  })
  const onNotify = (msg: { channel: string; payload?: string }) => {
    if (msg.channel === channel) seen.push(msg.payload ?? '')
  }
  client.on('notification', onNotify)
  const timer = setTimeout(() => resolve(seen), timeoutMs)
  const stop = () => {
    clearTimeout(timer)
    client.off('notification', onNotify)
    resolve(seen)
  }
  return { promise, stop }
}

const pool = getBrokerPool()
const agentRow = await pool.query<{ id: number; workspace_id: number }>(
  `SELECT id, workspace_id FROM agents WHERE enabled = true ORDER BY id LIMIT 1`,
)
if (agentRow.rows.length === 0) throw new Error('No enabled agent to build a fixture with.')
const { id: agentId, workspace_id: workspaceId } = agentRow.rows[0]

const listener = new Client({ connectionString: process.env.DATABASE_URI || '' })
await listener.connect()
await listener.query(`LISTEN ${ch.CHANNEL_EVENTS_CHANNEL}`)
await listener.query(`LISTEN ${ch.CHANNEL_TYPING_CHANNEL}`)

let teamId: number | null = null
let otherTeamId: number | null = null
try {
  const team = await teams.createTeam({ workspaceId, name: `realtime-probe-${Date.now() % 100000}` })
  teamId = team.id
  const other = await teams.createTeam({ workspaceId, name: `realtime-probe-other-${Date.now() % 100000}` })
  otherTeamId = other.id
  const alice = await teams.addTeamMember({ teamId: team.id, agentId, displayName: 'Alice', role: 'leader' })
  const bob = await teams.addTeamMember({ teamId: team.id, agentId, displayName: 'Bob' })

  // --- 1. posting a message notifies THIS team's channel ---
  {
    const wait = waitForNotification(listener, ch.CHANNEL_EVENTS_CHANNEL, 3000)
    const message = await ch.postChannelMessage({ teamId: team.id, fromSlotId: alice.id, body: 'Shipping today.' })
    const payloads = await wait.promise
    const parsed = payloads.map((p) => JSON.parse(p) as { teamId: number })
    check('posting a message NOTIFYs the channel', parsed.some((p) => p.teamId === team.id), JSON.stringify(parsed))
    void message
  }

  // --- 2. a reaction notifies too, when teamId is passed ---
  {
    const root = await ch.postChannelMessage({ teamId: team.id, fromSlotId: alice.id, body: 'React to this.' })
    const wait = waitForNotification(listener, ch.CHANNEL_EVENTS_CHANNEL, 3000)
    await ch.toggleReaction({ messageId: root.id, actorSlotId: bob.id, emoji: '👍', teamId: team.id })
    const payloads = await wait.promise
    const parsed = payloads.map((p) => JSON.parse(p) as { teamId: number })
    check('reacting NOTIFYs the channel', parsed.some((p) => p.teamId === team.id), JSON.stringify(parsed))
  }

  // --- 3. a reaction WITHOUT teamId does not throw and does not notify ---
  // (the optional-param compatibility path — see channels.ts's own comment)
  {
    const root = await ch.postChannelMessage({ teamId: team.id, fromSlotId: alice.id, body: 'React again.' })
    // `postChannelMessage`'s own notify is fire-and-forget (`void
    // notifyChannelEvent(...)`), so the `await` above only guarantees the row
    // exists — not that its NOTIFY has finished its round trip to this
    // listener yet. Without settling first, that stray notification lands
    // inside the very window below that is checking for the ABSENCE of one,
    // which is a race in this harness, not evidence about the code under test.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const wait = waitForNotification(listener, ch.CHANNEL_EVENTS_CHANNEL, 1500)
    const result = await ch.toggleReaction({ messageId: root.id, actorSlotId: bob.id, emoji: '🎉' })
    const payloads = await wait.promise
    check('a reaction with no teamId still succeeds', result.added === true)
    check('and does not fire a spurious notify', payloads.length === 0, JSON.stringify(payloads))
  }

  // --- 4. one team's event never reaches a listener filtering for another ---
  {
    const wait = waitForNotification(listener, ch.CHANNEL_EVENTS_CHANNEL, 3000)
    await ch.postChannelMessage({ teamId: other.id, fromSlotId: null, body: 'Different room entirely.' })
    const payloads = await wait.promise
    const parsed = payloads.map((p) => JSON.parse(p) as { teamId: number })
    check(
      'a message in a different channel carries THAT channel\'s id, not this one\'s',
      parsed.every((p) => p.teamId !== team.id) && parsed.some((p) => p.teamId === other.id),
      JSON.stringify(parsed),
    )
  }

  // --- 5. typing is a notify with NO row written ---
  {
    const before = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM team_messages WHERE team_id = $1`, [
      team.id,
    ])
    const wait = waitForNotification(listener, ch.CHANNEL_TYPING_CHANNEL, 3000)
    await ch.notifyTyping(team.id, bob.id)
    const payloads = await wait.promise
    const parsed = payloads.map((p) => JSON.parse(p) as { teamId: number; slotId: number; at: number })
    check('typing publishes a notification', parsed.some((p) => p.teamId === team.id && p.slotId === bob.id), JSON.stringify(parsed))
    const after = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM team_messages WHERE team_id = $1`, [
      team.id,
    ])
    check('and writes no row at all', before.rows[0].n === after.rows[0].n, `${before.rows[0].n} -> ${after.rows[0].n}`)
  }

  // --- 6. resolving an approval notifies the channel it was raised in ---
  //
  // The fourth write path, and the one with no `team_messages` row of its
  // own to ride on — a decision never inserts a message, only the earlier
  // block-announcement does (`announceApprovalInChannel`). Without its own
  // notify the approval strip would sit on screen, already stale, for up to
  // the poll interval after somebody clicked Approve.
  {
    const userRow = await pool.query<{ id: number }>('SELECT id FROM users ORDER BY id LIMIT 1')
    const userId = userRow.rows[0].id
    const session = await createSession({ workspaceId, agentId, createdBy: userId, title: 'realtime probe' })
    const carol = await teams.addTeamMember({
      teamId: team.id,
      agentId,
      displayName: 'Carol',
      sessionId: session.id,
    })
    const trigger = await ch.postChannelMessage({ teamId: team.id, fromSlotId: alice.id, body: '@Carol go' })
    const run = await enqueueRun({
      agentId,
      sessionId: session.id,
      originatorUser: userId,
      accountableUser: userId,
      prompt: 'probe',
      channelMessageId: trigger.id,
    })
    const externalId = `realtime-approval-${Date.now()}`
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO approvals (run_id, external_id, requested_user_id, title, detail, options, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, 'pending', now(), now()) RETURNING id`,
      [run.id, externalId, userId, 'run something', null],
    )
    const approvalId = Number(inserted.rows[0].id)

    await new Promise((resolve) => setTimeout(resolve, 500))
    const wait = waitForNotification(listener, ch.CHANNEL_EVENTS_CHANNEL, 3000)
    await resolveApproval(approvalId, { approved: true })
    const payloads = await wait.promise
    const parsed = payloads.map((p) => JSON.parse(p) as { teamId: number })
    check(
      'resolving an approval NOTIFYs the channel it was raised in',
      parsed.some((p) => p.teamId === team.id),
      JSON.stringify(parsed),
    )
    void carol
  }
} finally {
  await listener.query(`UNLISTEN *`).catch(() => undefined)
  await listener.end().catch(() => undefined)
  if (teamId != null) await teams.deleteTeam(teamId).catch(() => undefined)
  if (otherTeamId != null) await teams.deleteTeam(otherTeamId).catch(() => undefined)
  await closeBrokerPool()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

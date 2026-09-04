// Channels: threads, per-member unread, mentions, reactions.
//
// Two of these are the reason the design is shaped the way it is, so they are
// exercised rather than assumed:
//
//   * UNREAD IS PER MEMBER. `team_messages.read_at` is one timestamp on the
//     message and cannot say "Alice read it, Bob did not". If that were still
//     the mechanism, one person opening a channel would clear it for everyone.
//   * REACTIONS CANNOT RACE. A JSONB column would be read-modify-write, and
//     two people reacting in the same instant would lose one. The unique index
//     makes it impossible; this fires both at once to prove it.
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const teams = await import('../lib/broker/teams')
const ch = await import('../lib/broker/channels')
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

let teamId: number | null = null
try {
  const team = await teams.createTeam({ workspaceId, name: `channel-probe-${Date.now() % 100000}` })
  teamId = team.id
  const alice = await teams.addTeamMember({ teamId: team.id, agentId, displayName: 'Alice', role: 'leader' })
  const bob = await teams.addTeamMember({ teamId: team.id, agentId, displayName: 'Bob' })

  // --- Threads ---
  const root = await ch.postChannelMessage({ teamId: team.id, fromSlotId: alice.id, body: 'Shipping the parser today.' })
  const reply = await ch.postChannelMessage({
    teamId: team.id,
    fromSlotId: bob.id,
    body: 'I will take the tests.',
    threadRootId: root.id,
  })
  // A reply to a reply must re-point at the root rather than nest deeper.
  const nested = await ch.postChannelMessage({
    teamId: team.id,
    fromSlotId: alice.id,
    body: 'Good.',
    threadRootId: reply.id,
  })
  check('a reply to a reply is flattened to the root', nested.threadRootId === root.id, String(nested.threadRootId))

  const feed = await ch.listChannelFeed(team.id)
  check('the feed shows roots only', feed.length === 1 && feed[0].id === root.id, `${feed.length} roots`)
  check('the root carries its reply count', feed[0].replyCount === 2, String(feed[0].replyCount))
  check('and when the last reply arrived', Boolean(feed[0].lastReplyAt))

  const thread = await ch.listThread(root.id)
  check('a thread returns its root plus replies', thread.length === 3, `${thread.length}`)
  check('with the root first', thread[0].id === root.id)

  // A reply must not be able to cross channels.
  const other = await teams.createTeam({ workspaceId, name: `channel-probe-other-${Date.now() % 100000}` })
  let crossed = false
  try {
    await ch.postChannelMessage({ teamId: other.id, fromSlotId: null, body: 'x', threadRootId: root.id })
    crossed = true
  } catch {
    // expected
  }
  await teams.deleteTeam(other.id)
  check('a reply cannot cross into another channel', !crossed)

  // --- Unread, per member ---
  let unread = await ch.listChannelUnread([alice.id, bob.id])
  const aliceUnread = unread.find((u) => u.slotId === alice.id)
  const bobUnread = unread.find((u) => u.slotId === bob.id)
  // Alice wrote 2 of the 3; Bob wrote 1.
  check("a member's own messages are not unread to them", aliceUnread?.unreadCount === 1, String(aliceUnread?.unreadCount))
  check('but the others are unread to everyone else', bobUnread?.unreadCount === 2, String(bobUnread?.unreadCount))

  await ch.markChannelRead(alice.id, nested.id)
  unread = await ch.listChannelUnread([alice.id, bob.id])
  check(
    'marking one member read clears only that member',
    unread.find((u) => u.slotId === alice.id)?.unreadCount === 0 &&
      unread.find((u) => u.slotId === bob.id)?.unreadCount === 2,
    JSON.stringify(unread),
  )

  // The high-water mark must never move backwards.
  await ch.markChannelRead(alice.id, root.id)
  unread = await ch.listChannelUnread([alice.id])
  check('a stale read receipt cannot resurrect read messages', unread[0]?.unreadCount === 0, String(unread[0]?.unreadCount))

  // --- Mentions ---
  const roster = (await teams.listTeamMembers(team.id)).map((m) => ({ id: m.id, displayName: m.displayName }))
  const mentions = ch.parseMentions('can @Bob take this one?', roster)
  check('a mention resolves to a slot id', mentions.length === 1 && mentions[0].id === bob.id, JSON.stringify(mentions))

  await ch.postChannelMessage({
    teamId: team.id,
    fromSlotId: alice.id,
    body: 'can @Bob take this one?',
    mentions,
  })
  unread = await ch.listChannelUnread([alice.id, bob.id])
  check(
    'a mention is counted separately from ordinary unread',
    unread.find((u) => u.slotId === bob.id)?.mentionCount === 1,
    JSON.stringify(unread.find((u) => u.slotId === bob.id)),
  )

  // --- Reactions, including the race ---
  const [first, second] = await Promise.all([
    ch.toggleReaction({ messageId: root.id, actorSlotId: alice.id, emoji: '👍' }),
    ch.toggleReaction({ messageId: root.id, actorSlotId: bob.id, emoji: '👍' }),
  ])
  check('two simultaneous reactions both land', first.added && second.added)
  const withReactions = await ch.getChannelMessage(root.id)
  check(
    'and both are counted on one emoji',
    withReactions?.reactions.length === 1 && withReactions.reactions[0].count === 2,
    JSON.stringify(withReactions?.reactions),
  )
  check(
    'with the actors recorded, so "you reacted" needs no second query',
    (withReactions?.reactions[0].actorSlotIds ?? []).includes(alice.id),
  )

  const off = await ch.toggleReaction({ messageId: root.id, actorSlotId: alice.id, emoji: '👍' })
  check('reacting again removes it', off.added === false)
  const afterToggle = await ch.getChannelMessage(root.id)
  check('and the count drops', afterToggle?.reactions[0]?.count === 1, JSON.stringify(afterToggle?.reactions))
} finally {
  if (teamId != null) await teams.deleteTeam(teamId).catch(() => undefined)
  await closeBrokerPool()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

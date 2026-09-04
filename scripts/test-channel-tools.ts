// R6.4 verification — is a dispatched agent actually a PARTICIPANT in the
// channel, over HTTP, with the same authorisation it has everywhere else?
//
// `scripts/test-teams-mcp.ts` proves the endpoint authenticates a slot and
// enforces the leader rules; this proves the surface added on top of it. The
// four things it checks that nothing below the HTTP layer can check:
//
//   * a threaded reply is written as a reply — under its root, and ABSENT from
//     the feed, which is the entire difference between a conversation and a
//     log;
//   * `thread_root_id` is an id straight off the wire, so a reply pointed at
//     another channel's message is refused AND writes nothing;
//   * a reaction toggles, and cannot be placed on another channel's message;
//   * an agent naming a teammate produces a real mention row, resolved against
//     THIS channel's roster only — "@Outsider" from another team is text, not
//     a mention.
//
// Plus the permission model, unchanged: a member is still refused an
// 'instruction'.
//
// Own fixtures over raw pg, torn down in `finally`. Deliberately NO Payload
// client: a live server already holds Payload and broker pools against a
// 15-connection limit, and a second Payload instance here exhausted it — which
// surfaced as a completely misleading "Agent missing or disabled" from an
// unrelated part of the app. Raw pg, `max: 4`, and nothing else.
//
//   npx tsx scripts/test-channel-tools.ts [baseUrl]
//
// Start the server yourself first — this script never starts one, and says so
// plainly if nothing is listening.
import { randomUUID } from 'node:crypto'

import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const BASE = (process.argv[2] ?? process.env.NOTIONFORGE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const ENDPOINT = `${BASE}/api/mcp/teams`

const { Pool } = await import('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 4 })

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

interface RpcResult {
  status: number
  body: unknown
  raw: string
}

/** One MCP call over Streamable HTTP. The client must advertise both content
 * types; the transport decides which it answers with. */
async function rpc(method: string, params: unknown, headers: Record<string, string>): Promise<RpcResult> {
  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  } catch (err) {
    // The single most likely reason this script fails, so it gets its own
    // message rather than an ECONNREFUSED stack forty lines down.
    console.error(`\nCould not reach ${ENDPOINT}.`)
    console.error('Start the app first (npm run dev) and re-run this script; it never starts a server itself.')
    console.error(String(err))
    process.exit(2)
  }
  const text = await response.text()
  const line = text.split('\n').find((l) => l.startsWith('data: '))
  const raw = line ? line.slice(6) : text
  let body: unknown = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    body = raw
  }
  return { status: response.status, body, raw: text }
}

const INIT_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'notionforge-channel-tools-test', version: '1.0.0' },
}

/** The three headers a dispatched member sends. */
function auth(token: string, runId: number, slotId: number): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-Run-Id': String(runId),
    'X-Team-Slot-Id': String(slotId),
  }
}

function toolText(result: RpcResult): string {
  const content = (result.body as { result?: { content?: Array<{ text?: string }> } })?.result?.content
  return content?.map((part) => part.text ?? '').join('') ?? ''
}

function toolIsError(result: RpcResult): boolean {
  return (result.body as { result?: { isError?: boolean } })?.result?.isError === true
}

/** A successful tool result's JSON payload, or null if it was an error or not
 * JSON. Every tool touched by this unit answers in JSON precisely so an agent
 * — and this script — does not have to parse ids back out of prose. */
function toolJson<T>(result: RpcResult): T | null {
  if (toolIsError(result)) return null
  try {
    return JSON.parse(toolText(result)) as T
  } catch {
    return null
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<RpcResult> {
  return rpc('tools/call', { name, arguments: args }, headers)
}

interface PostedMessage {
  id: number
  thread: number | null
  mentions: Array<{ type: string; id: number }>
  from: number | null
  body: string
}

// Fixture ids, filled in below and torn down in `finally` whatever happens.
const teamIds: number[] = []
const runIds: number[] = []
const sessionIds: number[] = []

try {
  const user = await pool.query<{ id: number }>('SELECT id FROM users ORDER BY id LIMIT 1')
  if (user.rows.length === 0) throw new Error('No users exist; cannot create a test run.')
  const userId = user.rows[0].id

  const workspace = await pool.query<{ id: number }>('SELECT id FROM workspaces ORDER BY id LIMIT 1')
  const workspaceId = workspace.rows[0]?.id ?? null
  if (workspaceId == null) throw new Error('No workspaces exist; cannot create a test team.')

  // Synthetic agent ids: `team_members.agent_id` and `runs.agent_id` carry no
  // foreign key (migrations 0001 and 0009), and this endpoint only ever
  // compares the run's agent to the slot's. Fabricated ids keep the fixture
  // from depending on which agents happen to exist, and keep the test off real
  // ones.
  const stamp = Date.now() % 1_000_000
  const agentLeader = 910_000_000 + stamp
  const agentMember = agentLeader + 1
  const agentOutsider = agentLeader + 2

  async function makeTeam(label: string): Promise<number> {
    const team = await pool.query<{ id: string }>(
      `INSERT INTO teams (workspace_id, name, description, workspace_mode, created_by)
       VALUES ($1, $2, $3, 'per_member', $4) RETURNING id`,
      [workspaceId, `channel-test ${label} ${randomUUID().slice(0, 8)}`, 'Created by scripts/test-channel-tools.ts.', userId],
    )
    const id = Number(team.rows[0].id)
    teamIds.push(id)
    return id
  }

  const teamId = await makeTeam('room')
  // A SECOND channel, which exists only to be the thing the first one must not
  // be able to reach: its message is the cross-channel reply target and the
  // out-of-roster reaction target, and its slot's display name is the "@name
  // that must not resolve".
  const otherTeamId = await makeTeam('other room')

  /** A slot plus the session and `running` run that speak as it. */
  async function makeSlot(teamOf: number, agentId: number, name: string, role: 'leader' | 'member') {
    const session = await pool.query<{ id: string }>(
      `INSERT INTO chat_sessions (workspace_id, agent_id, title) VALUES ($1, $2, $3) RETURNING id`,
      [workspaceId, agentId, `channel-tools-test ${name}`],
    )
    const sessionId = Number(session.rows[0].id)
    sessionIds.push(sessionId)
    const slot = await pool.query<{ id: string }>(
      `INSERT INTO team_members (team_id, agent_id, role, display_name, session_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [teamOf, agentId, role, name, sessionId],
    )
    const token = randomUUID()
    const run = await pool.query<{ id: string }>(
      `INSERT INTO runs (status, accountable_user, run_token, agent_id, session_id)
       VALUES ('running', $1, $2, $3, $4) RETURNING id`,
      [userId, token, agentId, sessionId],
    )
    const runId = Number(run.rows[0].id)
    runIds.push(runId)
    return { slotId: Number(slot.rows[0].id), runId, token, sessionId, agentId }
  }

  // Names chosen so neither is a prefix of the other: `parseMentions` matches
  // "@" + display name as a substring, and two names where one contains the
  // other would make a passing mention test meaningless.
  const leader = await makeSlot(teamId, agentLeader, 'Lead', 'leader')
  const member = await makeSlot(teamId, agentMember, 'Second', 'member')
  const outsider = await makeSlot(otherTeamId, agentOutsider, 'Outsider', 'member')

  // A message in the OTHER channel, written directly: it needs no tool call,
  // and giving the outsider a run that could post it would only add fixtures.
  const foreign = await pool.query<{ id: string }>(
    `INSERT INTO team_messages (team_id, from_slot_id, kind, body)
     VALUES ($1, $2, 'status', $3) RETURNING id`,
    [otherTeamId, outsider.slotId, 'a message in a channel you are not in'],
  )
  const foreignMessageId = Number(foreign.rows[0].id)

  const leaderAuth = auth(leader.token, leader.runId, leader.slotId)
  const memberAuth = auth(member.token, member.runId, member.slotId)

  console.log(`endpoint: ${ENDPOINT}`)
  console.log(`channel ${teamId}: leader slot ${leader.slotId}, member slot ${member.slotId}`)
  console.log(`other channel ${otherTeamId}: slot ${outsider.slotId}, message ${foreignMessageId}`)
  console.log('')

  // --- The surface is actually advertised ---------------------------------

  const init = await rpc('initialize', INIT_PARAMS, leaderAuth)
  check('initialize succeeds', init.status === 200, `status ${init.status}`)

  const list = await rpc('tools/list', {}, leaderAuth)
  const tools = ((list.body as { result?: { tools?: Array<{ name: string; inputSchema?: unknown }> } })?.result
    ?.tools ?? [])
  const names = tools.map((t) => t.name).sort()
  check('exposes team_read_thread', names.includes('team_read_thread'), names.join(', '))
  check('exposes team_react', names.includes('team_react'), names.join(', '))
  const sendSchema = tools.find((t) => t.name === 'team_send_message')?.inputSchema as
    | { properties?: Record<string, unknown> }
    | undefined
  check(
    'team_send_message advertises threadRootId',
    Boolean(sendSchema?.properties && 'threadRootId' in sendSchema.properties),
    Object.keys(sendSchema?.properties ?? {}).join(', '),
  )

  // --- A threaded reply lands under its root, and NOT in the feed ----------

  const rootBody = `who owns the migration? ${randomUUID().slice(0, 8)}`
  const rootResult = await callTool('team_send_message', { kind: 'question', body: rootBody }, leaderAuth)
  const root = toolJson<PostedMessage>(rootResult)
  check('leader can post a channel root', root != null, toolText(rootResult).slice(0, 200))
  check('a root has no thread of its own', root?.thread === null, JSON.stringify(root?.thread))

  const replyBody = `I do — picking it up now ${randomUUID().slice(0, 8)}`
  const replyResult = await callTool(
    'team_send_message',
    { kind: 'answer', body: replyBody, threadRootId: root?.id },
    memberAuth,
  )
  const reply = toolJson<PostedMessage>(replyResult)
  check('a member can reply into the thread', reply != null, toolText(replyResult).slice(0, 200))
  check('the reply reports the root it landed under', reply?.thread === root?.id, `${reply?.thread} vs ${root?.id}`)

  // The database's own answer, not the tool's. `thread_root_id` is the column
  // the feed's partial index is built on, so this is the fact everything
  // downstream reads.
  const stored = await pool.query<{ thread_root_id: string | null }>(
    `SELECT thread_root_id FROM team_messages WHERE id = $1`,
    [reply?.id ?? -1],
  )
  check(
    'the row is stored as a reply, not a root',
    stored.rows[0]?.thread_root_id != null && Number(stored.rows[0].thread_root_id) === root?.id,
    JSON.stringify(stored.rows[0] ?? null),
  )

  // The feed's exact predicate (`listChannelFeed`: roots only). The reply must
  // be absent from it — a reply that also shows in the feed is the flat log
  // this whole unit exists to stop.
  const feed = await pool.query<{ id: string }>(
    `SELECT id FROM team_messages WHERE team_id = $1 AND thread_root_id IS NULL ORDER BY id`,
    [teamId],
  )
  const feedIds = feed.rows.map((r) => Number(r.id))
  check('the root is in the channel feed', root != null && feedIds.includes(root.id), feedIds.join(', '))
  check('the reply is NOT in the channel feed', reply != null && !feedIds.includes(reply.id), feedIds.join(', '))

  // --- The thread is readable, by a member, and resolves from any id -------

  const threadResult = await callTool('team_read_thread', { rootId: root?.id }, memberAuth)
  const thread = toolJson<{ root: number; count: number; messages: PostedMessage[] }>(threadResult)
  check('a member can read the thread', thread != null, toolText(threadResult).slice(0, 200))
  check(
    'the thread contains the root and the reply, in order',
    thread?.messages?.length === 2 &&
      thread.messages[0].id === root?.id &&
      thread.messages[1].id === reply?.id,
    JSON.stringify(thread?.messages?.map((m) => m.id) ?? null),
  )

  // Replying to a REPLY must attach to the same thread rather than nesting —
  // `postChannelMessage` re-points it at the root. A model handed a thread
  // will quote the last message in it, so this is the ordinary case, not an
  // edge one.
  const nestedResult = await callTool(
    'team_send_message',
    { kind: 'answer', body: `thanks ${randomUUID().slice(0, 8)}`, threadRootId: reply?.id },
    leaderAuth,
  )
  const nested = toolJson<PostedMessage>(nestedResult)
  check('a reply to a reply is flattened onto the root', nested?.thread === root?.id, `${nested?.thread} vs ${root?.id}`)

  // And reading BY a reply id resolves to the whole thread rather than
  // returning a one-message "thread" the model would read as "nobody answered".
  const byReply = toolJson<{ root: number; count: number }>(
    await callTool('team_read_thread', { rootId: reply?.id }, memberAuth),
  )
  check('reading by a reply id resolves to its root', byReply?.root === root?.id, JSON.stringify(byReply))
  check('and returns the whole thread', byReply?.count === 3, JSON.stringify(byReply?.count))

  // --- The same body twice is not swallowed as a retry ---------------------
  //
  // `team_send_message` is deduplicated within a ten-minute window, so before
  // the thread id joined the fingerprint this exact pair — the same sentence
  // posted flat and then under a question — was one call, and the reply was
  // silently dropped.
  const echo = `noted ${randomUUID().slice(0, 8)}`
  const flat = toolJson<PostedMessage>(await callTool('team_send_message', { body: echo }, memberAuth))
  const threaded = toolJson<PostedMessage>(
    await callTool('team_send_message', { body: echo, threadRootId: root?.id }, memberAuth),
  )
  check(
    'the same body posted flat and threaded is two messages',
    flat != null && threaded != null && flat.id !== threaded.id && threaded.thread === root?.id,
    `${flat?.id} / ${threaded?.id} (thread ${threaded?.thread})`,
  )

  // --- A cross-channel reply is refused, and writes nothing ---------------

  const crossChannel = await callTool(
    'team_send_message',
    { body: 'reaching into another room', threadRootId: foreignMessageId },
    memberAuth,
  )
  check(
    'a reply pointed at another channel is refused',
    toolIsError(crossChannel) && /different channel/i.test(toolText(crossChannel)),
    toolText(crossChannel).slice(0, 200),
  )
  const crossWrote = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM team_messages WHERE thread_root_id = $1 OR body = 'reaching into another room'`,
    [foreignMessageId],
  )
  check('the refused reply wrote nothing', Number(crossWrote.rows[0].n) === 0, crossWrote.rows[0].n)

  // Reading another channel's thread is refused for the same reason, with a
  // message that does not distinguish "no such id" from "not yours" — the
  // distinction would enumerate every other channel's message ids.
  const foreignThread = await callTool('team_read_thread', { rootId: foreignMessageId }, memberAuth)
  check(
    "another channel's thread is not readable",
    toolIsError(foreignThread) && /not in your channel/i.test(toolText(foreignThread)),
    toolText(foreignThread).slice(0, 200),
  )

  // --- A reaction toggles -------------------------------------------------

  const reactOn = toolJson<{ added: boolean }>(
    await callTool('team_react', { messageId: root?.id, emoji: '👍' }, memberAuth),
  )
  check('a member can react', reactOn?.added === true, JSON.stringify(reactOn))
  const afterAdd = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM team_message_reactions WHERE message_id = $1 AND actor_slot_id = $2 AND emoji = '👍'`,
    [root?.id ?? -1, member.slotId],
  )
  check('the reaction is stored exactly once', Number(afterAdd.rows[0].n) === 1, afterAdd.rows[0].n)

  const reactOff = toolJson<{ added: boolean }>(
    await callTool('team_react', { messageId: root?.id, emoji: '👍' }, memberAuth),
  )
  check('the same call takes the reaction back', reactOff?.added === false, JSON.stringify(reactOff))
  const afterRemove = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM team_message_reactions WHERE message_id = $1 AND actor_slot_id = $2 AND emoji = '👍'`,
    [root?.id ?? -1, member.slotId],
  )
  check('and the row is gone', Number(afterRemove.rows[0].n) === 0, afterRemove.rows[0].n)

  // `toggleReaction` takes a bare message id, so this is the check that stops
  // a slot decorating — and probing the existence of — another room's messages.
  const foreignReact = await callTool('team_react', { messageId: foreignMessageId, emoji: '👍' }, memberAuth)
  check(
    "a message in another channel cannot be reacted to",
    toolIsError(foreignReact) && /not in your channel/i.test(toolText(foreignReact)),
    toolText(foreignReact).slice(0, 200),
  )
  const foreignReactWrote = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM team_message_reactions WHERE message_id = $1`,
    [foreignMessageId],
  )
  check('the refused reaction wrote nothing', Number(foreignReactWrote.rows[0].n) === 0)

  // --- An agent naming a teammate produces a real mention -----------------

  const mentionBody = `@Lead I hit a wall on this ${randomUUID().slice(0, 8)}`
  const mentioned = toolJson<PostedMessage>(
    await callTool('team_send_message', { kind: 'question', body: mentionBody, threadRootId: root?.id }, memberAuth),
  )
  check(
    'the tool reports the mention it resolved',
    mentioned?.mentions?.length === 1 &&
      mentioned.mentions[0].type === 'slot' &&
      mentioned.mentions[0].id === leader.slotId,
    JSON.stringify(mentioned?.mentions),
  )
  // The indexed column, queried the way `listChannelUnread` queries it: a
  // mention that is not found by THIS containment test does not raise a badge,
  // whatever the tool reported.
  const mentionRow = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM team_messages
      WHERE id = $1 AND mentions @> jsonb_build_array(jsonb_build_object('type', 'slot', 'id', $2::int))`,
    [mentioned?.id ?? -1, leader.slotId],
  )
  check('the mention is indexed as a slot mention', Number(mentionRow.rows[0].n) === 1, mentionRow.rows[0].n)
  // The body is an index, not a rewrite: the text the leader reads is the text
  // the member wrote.
  const bodyRow = await pool.query<{ body: string }>(`SELECT body FROM team_messages WHERE id = $1`, [
    mentioned?.id ?? -1,
  ])
  check('the body is left exactly as written', bodyRow.rows[0]?.body === mentionBody, bodyRow.rows[0]?.body)

  // Mentions are resolved against THIS channel's roster only. "Outsider" is a
  // real slot, just not here, so it must stay plain text — otherwise an @name
  // would be a cross-channel notification primitive.
  const strayMention = toolJson<PostedMessage>(
    await callTool('team_send_message', { body: `@Outsider are you around? ${randomUUID().slice(0, 8)}` }, memberAuth),
  )
  check(
    "a name from another channel's roster is not a mention",
    strayMention != null && strayMention.mentions.length === 0,
    JSON.stringify(strayMention?.mentions),
  )

  // --- The permission model is unchanged ----------------------------------

  const memberInstruction = `do this now ${randomUUID().slice(0, 8)}`
  const refused = await callTool(
    'team_send_message',
    { kind: 'instruction', body: memberInstruction, threadRootId: root?.id },
    memberAuth,
  )
  check(
    "a member is still refused an 'instruction', even inside a thread",
    toolIsError(refused) && /only the team leader/i.test(toolText(refused)),
    toolText(refused).slice(0, 200),
  )
  const refusedWrote = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM team_messages WHERE body = $1`, [
    memberInstruction,
  ])
  check('the refused instruction wrote nothing', Number(refusedWrote.rows[0].n) === 0, refusedWrote.rows[0].n)

  // A leader-only board action, from the same member, to show the refusal is
  // the role rather than the message kind.
  const memberCreate = await callTool('team_create_task', { subject: 'member tries to assign work' }, memberAuth)
  check(
    'a member is still refused a leader-only board action',
    toolIsError(memberCreate) && /only the team leader/i.test(toolText(memberCreate)),
    toolText(memberCreate).slice(0, 200),
  )

  // The leader, by contrast, may instruct — so the refusal above is a rule and
  // not a broken code path.
  const leaderInstruction = await callTool(
    'team_send_message',
    { kind: 'instruction', body: `take the migration ${randomUUID().slice(0, 8)}`, to: member.slotId, threadRootId: root?.id },
    leaderAuth,
  )
  check('the leader may instruct in the thread', !toolIsError(leaderInstruction), toolText(leaderInstruction).slice(0, 200))
} finally {
  // Teams cascade to members, messages, reactions and tasks (migrations 0009
  // and 0013); runs and chat_sessions do not hang off them, so they go
  // separately. Best-effort: a cleanup failure must not mask a test failure.
  if (runIds.length > 0) {
    await pool.query('DELETE FROM runs WHERE id = ANY($1::bigint[])', [runIds]).catch(() => undefined)
  }
  if (teamIds.length > 0) {
    await pool.query('DELETE FROM teams WHERE id = ANY($1::bigint[])', [teamIds]).catch(() => undefined)
  }
  if (sessionIds.length > 0) {
    await pool.query('DELETE FROM chat_sessions WHERE id = ANY($1::bigint[])', [sessionIds]).catch(() => undefined)
  }
  await pool.end()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

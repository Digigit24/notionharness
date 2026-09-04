// R6.2 verification — can a DISPATCHED agent actually use a team, and is it
// refused everything it should be?
//
// `scripts/test-mcp-endpoint.ts` proves `/api/mcp` speaks MCP; this proves the
// same for `/api/mcp/teams`, which has a second authorisation half (`X-Team-
// Slot-Id`) that the page-writes endpoint does not, plus behaviour that only
// shows up with two callers at once: a message crossing between two slots, a
// task that two members claim simultaneously, and a leader-only tool refusing
// a member.
//
// Everything is exercised OVER HTTP against a running server, on purpose. The
// tool bodies in `lib/teams/tools.ts` can be called directly and would pass;
// what was actually broken was the wiring between a run and those tools —
// headers, the slot gate, the run-token comparison — and none of that exists
// below the HTTP layer.
//
// It builds its own fixtures (a team, three slots, three `running` runs) with
// raw SQL and deletes them again. The runs have synthetic agent ids and are
// never queued, so the dispatcher cannot pick them up mid-test.
//
//   npx tsx scripts/test-teams-mcp.ts [baseUrl]
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
  clientInfo: { name: 'notionforge-teams-test', version: '1.0.0' },
}

/** The three headers a dispatched member sends — the exact set
 * `lib/teams/registration.ts` writes into the plugin row as placeholders. */
function auth(token: string, runId: number, slotId: number): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-Run-Id': String(runId),
    'X-Team-Slot-Id': String(slotId),
  }
}

/** A tool result's text payload, or '' if the call did not produce one. */
function toolText(result: RpcResult): string {
  const content = (result.body as { result?: { content?: Array<{ text?: string }> } })?.result?.content
  return content?.map((part) => part.text ?? '').join('') ?? ''
}

function toolIsError(result: RpcResult): boolean {
  return (result.body as { result?: { isError?: boolean } })?.result?.isError === true
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<RpcResult> {
  return rpc('tools/call', { name, arguments: args }, headers)
}

// Fixture ids, filled in below and torn down in `finally` whatever happens.
let teamId: number | null = null
const runIds: number[] = []
const sessionIds: number[] = []
let createdPluginId: number | null = null

try {
  const user = await pool.query<{ id: number }>('SELECT id FROM users ORDER BY id LIMIT 1')
  if (user.rows.length === 0) throw new Error('No users exist; cannot create a test run.')
  const userId = user.rows[0].id

  // A real workspace when there is one, because the registration check below
  // writes a `plugins` row and Payload validates that relationship. The team
  // itself does not care — `teams.workspace_id` has no foreign key — but a
  // team parked in a workspace that exists is also easier to inspect if this
  // script ever dies before its cleanup.
  const workspace = await pool.query<{ id: number }>('SELECT id FROM workspaces ORDER BY id LIMIT 1')
  const workspaceId = workspace.rows[0]?.id ?? null
  if (workspaceId == null) throw new Error('No workspaces exist; cannot create a test team.')

  // Synthetic agent ids. `team_members.agent_id` and `runs.agent_id` carry no
  // foreign key (see migrations 0001 and 0009), and nothing in this endpoint
  // reads an agent row — it only compares the run's agent to the slot's. Using
  // fabricated ids keeps the fixture from depending on which agents happen to
  // exist, and keeps the test from touching real ones.
  const stamp = Date.now() % 1_000_000
  const agentLeader = 900_000_000 + stamp
  const agentMember = agentLeader + 1
  const agentStranger = agentLeader + 2

  const team = await pool.query<{ id: string }>(
    `INSERT INTO teams (workspace_id, name, description, workspace_mode, created_by)
     VALUES ($1, $2, $3, 'per_member', $4) RETURNING id`,
    [workspaceId, `mcp-test ${randomUUID().slice(0, 8)}`, 'Created by scripts/test-teams-mcp.ts.', userId],
  )
  teamId = Number(team.rows[0].id)

  /** A slot plus the session and `running` run that speak as it. */
  async function makeSlot(agentId: number, name: string, role: 'leader' | 'member') {
    const session = await pool.query<{ id: string }>(
      `INSERT INTO chat_sessions (workspace_id, agent_id, title) VALUES ($1, $2, $3) RETURNING id`,
      [workspaceId, agentId, `teams-mcp-test ${name}`],
    )
    const sessionId = Number(session.rows[0].id)
    sessionIds.push(sessionId)
    const slot = await pool.query<{ id: string }>(
      `INSERT INTO team_members (team_id, agent_id, role, display_name, session_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [teamId, agentId, role, name, sessionId],
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

  const leader = await makeSlot(agentLeader, 'Lead', 'leader')
  const member = await makeSlot(agentMember, 'Second', 'member')
  // A third slot filled by a DIFFERENT agent, used only to prove that holding
  // a valid run token does not let you act as somebody else's slot.
  const stranger = await makeSlot(agentStranger, 'Third', 'member')

  console.log(`endpoint: ${ENDPOINT}`)
  console.log(`team ${teamId}: leader slot ${leader.slotId}, member slot ${member.slotId}, other slot ${stranger.slotId}`)
  console.log('')

  // --- Authorisation ------------------------------------------------------
  //
  // Four refusals, each closing a different door. They come first because a
  // suite that only ever tests the happy path cannot tell a working
  // authorisation check from an absent one.

  const anon = await rpc('initialize', INIT_PARAMS, {})
  check('refuses a request with no credentials', anon.status === 401, `status ${anon.status}`)

  const noSlot = await rpc('initialize', INIT_PARAMS, {
    Authorization: `Bearer ${leader.token}`,
    'X-Run-Id': String(leader.runId),
  })
  check('refuses a request with no X-Team-Slot-Id', noSlot.status === 401, `status ${noSlot.status}`)

  const bogus = await rpc('initialize', INIT_PARAMS, auth(randomUUID(), leader.runId, leader.slotId))
  check("refuses a token that is not this run's", bogus.status === 401, `status ${bogus.status}`)

  // The run token is real, but it names a DIFFERENT run — the attack the
  // token-vs-run-id comparison exists to stop. `member.runId` is a genuine
  // run, so this is not merely "unknown run": it is the leader's token
  // presented as the member's run.
  const mismatched = await rpc('initialize', INIT_PARAMS, auth(leader.token, member.runId, member.slotId))
  check('refuses a valid token pointed at another run', mismatched.status === 401, `status ${mismatched.status}`)

  // Everything above proves you are run N. This proves run N may only act as
  // its own slot: the leader's own token and run id, pointed at a slot filled
  // by a third agent.
  const wrongSlot = await rpc('initialize', INIT_PARAMS, auth(leader.token, leader.runId, stranger.slotId))
  check(
    'refuses a valid run acting as a slot its agent does not fill',
    wrongSlot.status === 403,
    `status ${wrongSlot.status}`,
  )

  // --- The protocol -------------------------------------------------------

  const leaderAuth = auth(leader.token, leader.runId, leader.slotId)
  const memberAuth = auth(member.token, member.runId, member.slotId)

  const init = await rpc('initialize', INIT_PARAMS, leaderAuth)
  const initBody = init.body as { result?: { serverInfo?: { name?: string } } }
  check('initialize succeeds', init.status === 200, `status ${init.status}`)
  check(
    'identifies itself as the teams server',
    initBody?.result?.serverInfo?.name === 'notionforge-teams',
    JSON.stringify(initBody?.result?.serverInfo ?? init.body).slice(0, 200),
  )

  const list = await rpc('tools/list', {}, leaderAuth)
  const names = ((list.body as { result?: { tools?: Array<{ name: string }> } })?.result?.tools ?? [])
    .map((t) => t.name)
    .sort()
  check('advertises its tools', names.length > 0, names.join(', ') || JSON.stringify(list.body).slice(0, 200))
  check('exposes team_send_message', names.includes('team_send_message'))
  check('exposes team_claim_task', names.includes('team_claim_task'))

  // --- A message crossing between two slots -------------------------------

  const body = `hello from the leader ${randomUUID().slice(0, 8)}`
  const sent = await callTool('team_send_message', { to: member.slotId, kind: 'instruction', body }, leaderAuth)
  check('leader can send a directed instruction', !toolIsError(sent), toolText(sent).slice(0, 160))

  const inbox = await callTool('team_read_inbox', {}, memberAuth)
  check("the message arrives in the other slot's inbox", toolText(inbox).includes(body), toolText(inbox).slice(0, 200))

  // The leader must not see its own message come back — `readTeamInbox`
  // excludes `from_slot_id = me`, and an agent reading its own instructions
  // back would loop on them.
  const ownInbox = await callTool('team_read_inbox', {}, leaderAuth)
  check('a sender does not receive its own message', !toolText(ownInbox).includes(body))

  // --- A leader-only action, refused --------------------------------------

  const memberCreate = await callTool('team_create_task', { subject: 'member tries to assign work' }, memberAuth)
  check(
    'a member is refused a leader-only tool',
    toolIsError(memberCreate) && /only the team leader/i.test(toolText(memberCreate)),
    toolText(memberCreate).slice(0, 200),
  )
  // A refusal that also created the row would be worse than no refusal at all.
  const leaked = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM team_tasks WHERE team_id = $1 AND subject = 'member tries to assign work'`,
    [teamId],
  )
  check('the refused action wrote nothing', Number(leaked.rows[0].n) === 0)

  // --- One task, two claimants, at the same time ---------------------------

  const created = await callTool('team_create_task', { subject: 'the contested task' }, leaderAuth)
  check('leader can create a task', !toolIsError(created), toolText(created).slice(0, 160))
  const taskId = (() => {
    try {
      return Number((JSON.parse(toolText(created)) as { id: number }).id)
    } catch {
      return NaN
    }
  })()
  check('the created task has an id', Number.isFinite(taskId), toolText(created).slice(0, 200))

  if (Number.isFinite(taskId)) {
    // Both requests are in flight before either resolves — the race the
    // guarded UPDATE in `claimTeamTask` exists for. Two members polling the
    // same board is the ordinary case, not a contrived one.
    const [claimA, claimB] = await Promise.all([
      callTool('team_claim_task', { id: taskId }, leaderAuth),
      callTool('team_claim_task', { id: taskId }, memberAuth),
    ])
    const wonA = /"claimed":\s*true/.test(toolText(claimA))
    const wonB = /"claimed":\s*true/.test(toolText(claimB))
    check(
      'exactly one of two simultaneous claims wins',
      (wonA ? 1 : 0) + (wonB ? 1 : 0) === 1,
      `leader ${wonA ? 'won' : 'lost'}, member ${wonB ? 'won' : 'lost'}`,
    )
    // The loser is told why, and told not to retry — a race it can act on
    // rather than an error it will narrate as a fault.
    const loser = wonA ? claimB : claimA
    check('the loser is given a reason and told not to retry', /Do not retry/.test(toolText(loser)), toolText(loser).slice(0, 200))

    const owner = await pool.query<{ owner_slot_id: string | null; status: string }>(
      `SELECT owner_slot_id, status FROM team_tasks WHERE id = $1`,
      [taskId],
    )
    check(
      'the board records exactly one owner',
      owner.rows[0]?.owner_slot_id != null && owner.rows[0].status === 'claimed',
      JSON.stringify(owner.rows[0] ?? null),
    )
  }

  // --- A settled run must not keep writing --------------------------------

  await pool.query(`UPDATE runs SET status = 'completed' WHERE id = $1`, [member.runId])
  const settled = await rpc('initialize', INIT_PARAMS, memberAuth)
  check('refuses a run that has already finished', settled.status === 409, `status ${settled.status}`)

  // --- The registration and the substitution that make any of this reachable
  //
  // Everything above assumed a client that sets `X-Team-Slot-Id` itself. A
  // dispatched agent does not: it gets whatever `lib/plugins/resolve.ts` built
  // from a `plugins` row. This section checks the two halves of that wire.
  const { ensureTeamMcpPlugin } = await import('../lib/teams/registration')
  const first = await ensureTeamMcpPlugin(workspaceId)
  if (first.status === 'created') createdPluginId = first.id
  const second = await ensureTeamMcpPlugin(workspaceId)
  check(
    'registration is idempotent',
    second.status === 'existing' && second.id === first.id,
    `${first.status} ${first.id} then ${second.status} ${second.id}`,
  )

  const { resolvePluginsForRun } = await import('../lib/plugins/resolve')
  const withSlot = await resolvePluginsForRun({
    workspaceId,
    agentId: agentLeader,
    substitutions: { RUN_TOKEN: leader.token, RUN_ID: String(leader.runId), TEAM_SLOT_ID: String(leader.slotId) },
  })
  const teamServer = withSlot.servers.find(
    (server) => 'url' in server && typeof server.url === 'string' && server.url.endsWith('/api/mcp/teams'),
  )
  check('a run with a slot is given the team server', Boolean(teamServer), withSlot.servers.map((s) => s.name).join(', '))
  const slotHeader =
    teamServer && 'headers' in teamServer
      ? teamServer.headers.find((h) => h.name.toLowerCase() === 'x-team-slot-id')?.value
      : undefined
  check('its slot header is substituted, not a placeholder', slotHeader === String(leader.slotId), String(slotHeader))
  const tokenHeader =
    teamServer && 'headers' in teamServer
      ? teamServer.headers.find((h) => h.name.toLowerCase() === 'authorization')?.value
      : undefined
  check('its run token is substituted', tokenHeader === `Bearer ${leader.token}`, String(tokenHeader))

  // The same agent, dispatched for a run that is NOT a team member: the server
  // must be absent rather than present with a blank slot id.
  const withoutSlot = await resolvePluginsForRun({
    workspaceId,
    agentId: agentLeader,
    substitutions: { RUN_TOKEN: leader.token, RUN_ID: String(leader.runId) },
  })
  const leakedServer = withoutSlot.servers.some(
    (server) => 'url' in server && typeof server.url === 'string' && server.url.endsWith('/api/mcp/teams'),
  )
  check('a run with no slot is not given the team server', !leakedServer)
  check(
    'and it is not reported as a broken plugin either',
    !withoutSlot.skipped.some((entry) => entry.name === 'Team'),
    withoutSlot.skipped.map((s) => `${s.name} (${s.reason})`).join(', '),
  )
} finally {
  // Teams cascade to members, messages and tasks (migration 0009); runs and
  // chat_sessions do not hang off them, so they go separately. Best-effort:
  // a cleanup failure must not mask a test failure.
  if (runIds.length > 0) {
    await pool.query('DELETE FROM runs WHERE id = ANY($1::bigint[])', [runIds]).catch(() => undefined)
  }
  if (teamId !== null) await pool.query('DELETE FROM teams WHERE id = $1', [teamId]).catch(() => undefined)
  if (sessionIds.length > 0) {
    await pool.query('DELETE FROM chat_sessions WHERE id = ANY($1::bigint[])', [sessionIds]).catch(() => undefined)
  }
  if (createdPluginId !== null) {
    // Only when THIS run created it. A workspace that already had a team
    // plugin keeps it — deleting a human's configuration to tidy up after a
    // test would be worse than leaving a row behind.
    await import('../lib/payload')
      .then(({ getPayloadClient }) => getPayloadClient())
      .then((payload) => payload.delete({ collection: 'plugins', id: createdPluginId as number, overrideAccess: true }))
      .catch(() => undefined)
  }
  await pool.end()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

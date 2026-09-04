// R6.1/R6.3 — teams, slots, the mailbox, and the task graph.
//
// The organising decision, which most of this file follows from: **the board
// is authoritative, not the leader.**
//
// A leader agent that plans, splits work and assigns it is genuinely useful
// and genuinely fragile — it is an LLM doing dispatch, and if it stalls,
// everything behind it stalls with it. AionUi's design has exactly this single
// point of failure. So the leader writes to the board, and the board decides
// what is claimable: `claimableTasks` asks the database which tasks have all
// their dependencies satisfied, and any idle member can take one. A stalled
// leader degrades the team to self-service rather than stopping it, and the UI
// says so plainly instead of looking busy.
import { getBrokerPool } from './db'

export type TeamWorkspaceMode = 'shared' | 'per_member'
export type TeamRole = 'leader' | 'member'
export type TeamMessageKind = 'instruction' | 'report' | 'question' | 'answer' | 'status'
export type TeamTaskStatus = 'open' | 'claimed' | 'in_progress' | 'blocked' | 'done' | 'cancelled'

export interface Team {
  id: number
  workspaceId: number
  name: string
  description: string | null
  workspaceMode: TeamWorkspaceMode
  createdBy: number | null
  createdAt: string
}

export interface TeamMember {
  id: number
  teamId: number
  agentId: number
  role: TeamRole
  displayName: string
  colour: string | null
  sessionId: number | null
  worktreeId: number | null
}

export interface TeamMessage {
  id: number
  teamId: number
  fromSlotId: number | null
  /** Null means broadcast — deliberately a nullable column rather than a magic
   * slot id, so "everyone" cannot be confused with "a slot that was deleted". */
  toSlotId: number | null
  kind: TeamMessageKind
  body: string
  taskId: number | null
  readAt: string | null
  createdAt: string
}

export interface TeamTask {
  id: number
  teamId: number
  subject: string
  description: string | null
  ownerSlotId: number | null
  status: TeamTaskStatus
  result: string | null
  blockedBy: number[]
  createdAt: string
  updatedAt: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toTeam(row: any): Team {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    name: row.name,
    description: row.description,
    workspaceMode: row.workspace_mode,
    createdBy: row.created_by == null ? null : Number(row.created_by),
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function toMember(row: any): TeamMember {
  return {
    id: Number(row.id),
    teamId: Number(row.team_id),
    agentId: Number(row.agent_id),
    role: row.role,
    displayName: row.display_name,
    colour: row.colour,
    sessionId: row.session_id == null ? null : Number(row.session_id),
    worktreeId: row.worktree_id == null ? null : Number(row.worktree_id),
  }
}

function toMessage(row: any): TeamMessage {
  return {
    id: Number(row.id),
    teamId: Number(row.team_id),
    fromSlotId: row.from_slot_id == null ? null : Number(row.from_slot_id),
    toSlotId: row.to_slot_id == null ? null : Number(row.to_slot_id),
    kind: row.kind,
    body: row.body,
    taskId: row.task_id == null ? null : Number(row.task_id),
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function toTask(row: any): TeamTask {
  return {
    id: Number(row.id),
    teamId: Number(row.team_id),
    subject: row.subject,
    description: row.description,
    ownerSlotId: row.owner_slot_id == null ? null : Number(row.owner_slot_id),
    status: row.status,
    result: row.result,
    blockedBy: Array.isArray(row.blocked_by) ? row.blocked_by.filter((v: unknown) => v != null).map(Number) : [],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// --- Teams and slots --------------------------------------------------------

export async function createTeam(input: {
  workspaceId: number
  name: string
  description?: string | null
  workspaceMode?: TeamWorkspaceMode
  createdBy?: number | null
}): Promise<Team> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `INSERT INTO teams (workspace_id, name, description, workspace_mode, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      input.workspaceId,
      input.name,
      input.description ?? null,
      input.workspaceMode ?? 'per_member',
      input.createdBy ?? null,
    ],
  )
  const team = toTeam(rows[0])

  // R6.2 - a team is useless to a dispatched agent unless the workspace has a
  // plugin row pointing at `/api/mcp/teams`, so creating the first team is
  // what creates it. Three alternatives were considered and rejected:
  //
  //  - on page render: a GET that writes configuration, and one that would
  //    appear for a workspace nobody ever built a team in;
  //  - at dispatch time: a write on the hot path of every run, only to
  //    discover in the overwhelming majority of cases that it was there;
  //  - in the migration: the row needs this app's externally reachable URL
  //    (`NOTIONFORGE_URL`), which SQL does not have.
  //
  // Dynamically imported, and only on this path, because `lib/teams/
  // registration.ts` pulls in the Payload client: a static import would make
  // every consumer of `lib/broker` - the migration runner and half of
  // `scripts/` included - load a Payload config they do not need and may not
  // have. A failure is logged, not thrown: the team and its slots are real and
  // usable from the UI without the plugin row, and losing the team because its
  // tool registration failed would be the worse outcome. Registration is
  // idempotent, so a later team creation repairs it - and so does the
  // dispatcher, which re-asserts it for any run that turns out to occupy a
  // slot, since teams created before this wiring existed never came through
  // here at all.
  try {
    const { ensureTeamMcpPlugin } = await import('@/lib/teams/registration')
    await ensureTeamMcpPlugin(team.workspaceId)
  } catch (err) {
    console.warn(
      `[teams] Could not register the team MCP plugin for workspace ${team.workspaceId}; ` +
        `dispatched members of team ${team.id} will have no team tools until it exists.`,
      err,
    )
  }

  return team
}

export async function listTeams(workspaceId: number): Promise<Team[]> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(`SELECT * FROM teams WHERE workspace_id = $1 ORDER BY name`, [workspaceId])
  return rows.map(toTeam)
}

export async function getTeam(id: number): Promise<Team | null> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(`SELECT * FROM teams WHERE id = $1`, [id])
  return rows[0] ? toTeam(rows[0]) : null
}

export async function deleteTeam(id: number): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(`DELETE FROM teams WHERE id = $1`, [id])
}

export async function addTeamMember(input: {
  teamId: number
  agentId: number
  displayName: string
  role?: TeamRole
  colour?: string | null
  sessionId?: number | null
  worktreeId?: number | null
}): Promise<TeamMember> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `INSERT INTO team_members (team_id, agent_id, role, display_name, colour, session_id, worktree_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      input.teamId,
      input.agentId,
      input.role ?? 'member',
      input.displayName,
      input.colour ?? null,
      input.sessionId ?? null,
      input.worktreeId ?? null,
    ],
  )
  return toMember(rows[0])
}

export async function listTeamMembers(teamId: number): Promise<TeamMember[]> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    // Leader first, then stable by creation, so the room always renders in the
    // same order rather than shuffling as rows are touched.
    `SELECT * FROM team_members WHERE team_id = $1 ORDER BY (role = 'leader') DESC, id`,
    [teamId],
  )
  return rows.map(toMember)
}

export async function getTeamMember(id: number): Promise<TeamMember | null> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(`SELECT * FROM team_members WHERE id = $1`, [id])
  return rows[0] ? toMember(rows[0]) : null
}

export async function updateTeamMember(
  id: number,
  patch: { displayName?: string; colour?: string | null; sessionId?: number | null; worktreeId?: number | null },
): Promise<void> {
  const sets: string[] = []
  const values: unknown[] = [id]
  const push = (column: string, value: unknown) => {
    values.push(value)
    sets.push(`${column} = $${values.length}`)
  }
  if (patch.displayName !== undefined) push('display_name', patch.displayName)
  if (patch.colour !== undefined) push('colour', patch.colour)
  if (patch.sessionId !== undefined) push('session_id', patch.sessionId)
  if (patch.worktreeId !== undefined) push('worktree_id', patch.worktreeId)
  if (sets.length === 0) return
  const pool = getBrokerPool()
  await pool.query(`UPDATE team_members SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, values)
}

export async function removeTeamMember(id: number): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(`DELETE FROM team_members WHERE id = $1`, [id])
}

/**
 * Moves leadership to a slot, or clears it.
 *
 * One statement pair inside a transaction because the database enforces at
 * most one leader per team: demoting and promoting in the wrong order, or
 * without a transaction, transiently violates that index and fails.
 */
export async function setTeamLeader(teamId: number, slotId: number | null): Promise<void> {
  const pool = getBrokerPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`UPDATE team_members SET role = 'member' WHERE team_id = $1 AND role = 'leader'`, [teamId])
    if (slotId != null) {
      await client.query(`UPDATE team_members SET role = 'leader' WHERE id = $1 AND team_id = $2`, [slotId, teamId])
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

/**
 * Everything a dispatcher needs to know about a run whose session is a team
 * slot: which slot it is, and which checkout it should run in.
 *
 * The join is `chat_sessions.id = team_members.session_id`, because that is
 * the only link that exists - a run carries `session_id`, a slot carries
 * `session_id`, and nothing carries a slot id. (A `runs.team_slot_id` column
 * would be tighter, and is exactly what `lib/teams/tools.ts` asks for in its
 * "HONEST GAP" note, but adding it is a migration plus a change to every
 * enqueue site, which this unit does not own.)
 *
 * ONE query, not four. A run is dispatched constantly and this sits directly
 * on that path, so the team, the slot and the mode-resolved worktree all come
 * back together rather than as a chain of round trips (D0).
 *
 * Returns null when the session fills no slot - and ALSO when it somehow fills
 * more than one. `team_members.session_id` carries an index but no unique
 * constraint, so two slots sharing a session is representable; picking one of
 * them would hand a run an authority it cannot be shown to have. Absent beats
 * arbitrary, and the endpoint refuses an absent slot cleanly.
 */
export interface TeamRunBinding {
  teamId: number
  slotId: number
  agentId: number
  role: TeamRole
  displayName: string
  workspaceId: number
  workspaceMode: TeamWorkspaceMode
  /** The checkout this slot should run in under the team's `workspace_mode`,
   * or null when the mode's candidate is unbound. */
  worktreeId: number | null
  /** The two candidates the mode chose between, kept so a caller can explain
   * itself in a log line instead of just acting. */
  ownWorktreeId: number | null
  sharedWorktreeId: number | null
}

export async function getTeamBindingForSession(sessionId: number): Promise<TeamRunBinding | null> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    // `COALESCE(m.worktree_id, s.worktree_id)` on both sides because a slot
    // may be bound directly (`team_members.worktree_id`) or through the
    // conversation a human bound in Work (`chat_sessions.worktree_id`), and
    // from here the two mean the same thing: the checkout this slot works in.
    //
    // The correlated subquery picks the team's SHARED checkout, leader first
    // then oldest slot, so every member of a 'shared' team resolves to the
    // same row no matter which one is asking - a deterministic rule the roster
    // can restate, rather than "whichever happened to be bound last".
    `SELECT m.id             AS slot_id,
            m.team_id        AS team_id,
            m.agent_id       AS agent_id,
            m.role           AS role,
            m.display_name   AS display_name,
            t.workspace_id   AS workspace_id,
            t.workspace_mode AS workspace_mode,
            COALESCE(m.worktree_id, s.worktree_id) AS own_worktree_id,
            (SELECT COALESCE(m2.worktree_id, s2.worktree_id)
               FROM team_members m2
               LEFT JOIN chat_sessions s2 ON s2.id = m2.session_id
              WHERE m2.team_id = m.team_id
                AND COALESCE(m2.worktree_id, s2.worktree_id) IS NOT NULL
              ORDER BY (m2.role = 'leader') DESC, m2.id
              LIMIT 1) AS shared_worktree_id
       FROM team_members m
       JOIN teams t ON t.id = m.team_id
       LEFT JOIN chat_sessions s ON s.id = m.session_id
      WHERE m.session_id = $1
      LIMIT 2`,
    [sessionId],
  )
  if (rows.length !== 1) return null
  const row = rows[0]
  const own = row.own_worktree_id == null ? null : Number(row.own_worktree_id)
  const shared = row.shared_worktree_id == null ? null : Number(row.shared_worktree_id)
  const mode: TeamWorkspaceMode = row.workspace_mode === 'shared' ? 'shared' : 'per_member'
  return {
    teamId: Number(row.team_id),
    slotId: Number(row.slot_id),
    agentId: Number(row.agent_id),
    role: row.role === 'leader' ? 'leader' : 'member',
    displayName: row.display_name,
    workspaceId: Number(row.workspace_id),
    workspaceMode: mode,
    // This is the whole of what `teams.workspace_mode` does at run time:
    // 'shared' sends every slot to one checkout so they see each other's edits
    // immediately; 'per_member' sends each slot to its own and leaves the
    // merge for afterwards. Under 'per_member' an unbound slot resolves to
    // NOTHING rather than falling back to a teammate's checkout - the fallback
    // would silently turn a per-member team into a shared one, which is the
    // opposite of what was asked for.
    worktreeId: mode === 'shared' ? (shared ?? own) : own,
    ownWorktreeId: own,
    sharedWorktreeId: shared,
  }
}

// --- The mailbox ------------------------------------------------------------

export async function sendTeamMessage(input: {
  teamId: number
  fromSlotId: number | null
  toSlotId?: number | null
  kind?: TeamMessageKind
  body: string
  taskId?: number | null
}): Promise<TeamMessage> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `INSERT INTO team_messages (team_id, from_slot_id, to_slot_id, kind, body, task_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.teamId, input.fromSlotId, input.toSlotId ?? null, input.kind ?? 'status', input.body, input.taskId ?? null],
  )
  return toMessage(rows[0])
}

/**
 * One slot's inbox: everything addressed to it plus every broadcast.
 *
 * `since` is a message id, not a timestamp. Two messages can share a
 * millisecond; ids cannot, so a cursor built on them can never skip or repeat
 * a row — which for an agent polling its own inbox is the difference between
 * reliable delivery and an occasional lost instruction.
 */
export async function readTeamInbox(input: {
  teamId: number
  slotId: number
  since?: number
  limit?: number
}): Promise<TeamMessage[]> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `SELECT * FROM team_messages
      WHERE team_id = $1
        AND (to_slot_id = $2 OR to_slot_id IS NULL)
        AND id > $3
        AND (from_slot_id IS DISTINCT FROM $2)
      ORDER BY id
      LIMIT $4`,
    [input.teamId, input.slotId, input.since ?? 0, Math.min(input.limit ?? 100, 500)],
  )
  return rows.map(toMessage)
}

/** The room's whole feed, newest last, for the channel view. */
export async function listTeamMessages(teamId: number, options: { limit?: number; since?: number } = {}): Promise<TeamMessage[]> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `SELECT * FROM team_messages WHERE team_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
    [teamId, options.since ?? 0, Math.min(options.limit ?? 200, 1000)],
  )
  return rows.map(toMessage)
}

export async function markTeamMessagesRead(ids: number[]): Promise<void> {
  if (ids.length === 0) return
  const pool = getBrokerPool()
  await pool.query(`UPDATE team_messages SET read_at = now() WHERE id = ANY($1::bigint[]) AND read_at IS NULL`, [ids])
}

// --- The task graph ---------------------------------------------------------

const TASK_SELECT = `
  SELECT t.*,
         COALESCE(ARRAY_AGG(d.blocked_by) FILTER (WHERE d.blocked_by IS NOT NULL), '{}') AS blocked_by
    FROM team_tasks t
    LEFT JOIN team_task_deps d ON d.task_id = t.id
`

export async function createTeamTask(input: {
  teamId: number
  subject: string
  description?: string | null
  ownerSlotId?: number | null
  blockedBy?: number[]
}): Promise<TeamTask> {
  const pool = getBrokerPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `INSERT INTO team_tasks (team_id, subject, description, owner_slot_id, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        input.teamId,
        input.subject,
        input.description ?? null,
        input.ownerSlotId ?? null,
        // A task created with unmet dependencies starts blocked, so the board
        // is honest from the moment it exists rather than after a sweep.
        input.blockedBy && input.blockedBy.length > 0 ? 'blocked' : input.ownerSlotId ? 'claimed' : 'open',
      ],
    )
    const id = Number(rows[0].id)
    for (const blocker of input.blockedBy ?? []) {
      await client.query(
        `INSERT INTO team_task_deps (task_id, blocked_by) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, blocker],
      )
    }
    await client.query('COMMIT')
    const created = await getTeamTask(id)
    if (!created) throw new Error('Task vanished immediately after creation.')
    return created
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

export async function getTeamTask(id: number): Promise<TeamTask | null> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(`${TASK_SELECT} WHERE t.id = $1 GROUP BY t.id`, [id])
  return rows[0] ? toTask(rows[0]) : null
}

export async function listTeamTasks(teamId: number, options: { status?: TeamTaskStatus } = {}): Promise<TeamTask[]> {
  const pool = getBrokerPool()
  const params: unknown[] = [teamId]
  let where = 'WHERE t.team_id = $1'
  if (options.status) {
    params.push(options.status)
    where += ` AND t.status = $${params.length}`
  }
  const { rows } = await pool.query(`${TASK_SELECT} ${where} GROUP BY t.id ORDER BY t.id`, params)
  return rows.map(toTask)
}

/**
 * Tasks any idle member could pick up right now.
 *
 * This is what makes the board authoritative rather than the leader (R6.3).
 * A task is claimable when it is unowned, open or blocked, and every task it
 * depends on is done or cancelled — asked of the database in one query rather
 * than reconstructed in application code, so it stays true no matter which
 * process is asking and whether the leader is alive at all.
 */
export async function claimableTasks(teamId: number): Promise<TeamTask[]> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `${TASK_SELECT}
      WHERE t.team_id = $1
        AND t.owner_slot_id IS NULL
        AND t.status IN ('open', 'blocked')
        AND NOT EXISTS (
          SELECT 1
            FROM team_task_deps dep
            JOIN team_tasks blocker ON blocker.id = dep.blocked_by
           WHERE dep.task_id = t.id
             AND blocker.status NOT IN ('done', 'cancelled')
        )
      GROUP BY t.id
      ORDER BY t.id`,
    [teamId],
  )
  return rows.map(toTask)
}

/**
 * Claims a task for a slot, if nobody else got there first.
 *
 * The `owner_slot_id IS NULL` guard is in the UPDATE rather than in a prior
 * read, so two members claiming simultaneously cannot both win: one row is
 * updated, the other statement matches nothing and returns null. Doing this as
 * read-then-write would be a race with a very plausible trigger, since idle
 * members poll the same board.
 */
export async function claimTeamTask(taskId: number, slotId: number): Promise<TeamTask | null> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    // The dependency check is repeated from `claimableTasks` ON PURPOSE, and
    // it must stay here rather than only there.
    //
    // `claimableTasks` decides what to OFFER; this decides what may be TAKEN.
    // Without the check in the UPDATE, a member could claim a task whose
    // prerequisites are unfinished — by holding a stale board, by racing a
    // dependency that had not settled yet, or simply by calling the tool
    // directly, since `team_claim_task` takes an id. That would quietly break
    // the invariant the whole design rests on (R6.3: the board is
    // authoritative), and it would break it in the least visible way: work
    // started too early looks like work.
    `UPDATE team_tasks
        SET owner_slot_id = $2, status = 'claimed', updated_at = now()
      WHERE id = $1
        AND owner_slot_id IS NULL
        AND status IN ('open', 'blocked')
        AND NOT EXISTS (
          SELECT 1
            FROM team_task_deps dep
            JOIN team_tasks blocker ON blocker.id = dep.blocked_by
           WHERE dep.task_id = team_tasks.id
             AND blocker.status NOT IN ('done', 'cancelled')
        )
      RETURNING id`,
    [taskId, slotId],
  )
  if (rows.length === 0) return null
  return getTeamTask(taskId)
}

export async function updateTeamTaskStatus(taskId: number, status: TeamTaskStatus): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(`UPDATE team_tasks SET status = $2, updated_at = now() WHERE id = $1`, [taskId, status])
}

export interface ReportDoneResult {
  task: TeamTask | null
  /** Tasks that became claimable because this one finished. Returned so the
   * caller can say what was unblocked instead of leaving it to be discovered
   * on the next poll. */
  released: TeamTask[]
}

/**
 * The acknowledged completion edge — the thing AionUi's design lacks.
 *
 * Settles the task, records what it produced, and writes the report into the
 * mailbox, in one transaction. Splitting these would allow the state that
 * makes a team quietly wrong: a task marked done with nobody told, or a report
 * about work the board still shows as in progress.
 */
export async function reportTeamTaskDone(input: {
  taskId: number
  slotId: number | null
  summary: string
}): Promise<ReportDoneResult> {
  const pool = getBrokerPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `UPDATE team_tasks SET status = 'done', result = $2, updated_at = now()
        WHERE id = $1 RETURNING team_id`,
      [input.taskId, input.summary],
    )
    if (rows.length === 0) {
      await client.query('ROLLBACK')
      return { task: null, released: [] }
    }
    const teamId = Number(rows[0].team_id)
    await client.query(
      `INSERT INTO team_messages (team_id, from_slot_id, to_slot_id, kind, body, task_id)
       VALUES ($1, $2, NULL, 'report', $3, $4)`,
      [teamId, input.slotId, input.summary, input.taskId],
    )
    // A task that was only blocked by this one is now genuinely open, so say so
    // in the same transaction rather than leaving the board briefly lying.
    await client.query(
      `UPDATE team_tasks SET status = 'open', updated_at = now()
        WHERE team_id = $1
          AND status = 'blocked'
          AND owner_slot_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM team_task_deps dep
              JOIN team_tasks blocker ON blocker.id = dep.blocked_by
             WHERE dep.task_id = team_tasks.id
               AND blocker.status NOT IN ('done', 'cancelled')
          )`,
      [teamId],
    )
    await client.query('COMMIT')
    const [task, released] = await Promise.all([getTeamTask(input.taskId), claimableTasks(teamId)])
    return { task, released }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}


/**
 * Returns a task to the pool.
 *
 * Setting a task's status back to `open` is not enough on its own:
 * `owner_slot_id` stays set, and both `claimableTasks` and `claimTeamTask`
 * require it to be NULL. The task then shows as open on the board and is
 * unclaimable by anyone, forever — a dead end reachable by an ordinary status
 * change, which is why releasing is its own operation rather than something a
 * caller is expected to remember to do in two statements.
 */
export async function releaseTeamTask(taskId: number): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(
    `UPDATE team_tasks
        SET owner_slot_id = NULL,
            status = CASE WHEN status IN ('done', 'cancelled') THEN status ELSE 'open' END,
            updated_at = now()
      WHERE id = $1`,
    [taskId],
  )
}

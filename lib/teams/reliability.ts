// R6.6 — teams reliability: heartbeats, lost slots, dead letters, idempotent
// tool calls, and a room-wide stop.
//
// THE ORGANISING DECISION: silence is the signal, and it is DERIVED, never
// separately reported.
//
// R3.5 already settled the first half for a single run. `sendTurn` runs two
// caps — a wall clock and an inactivity watchdog — because a legitimately long
// turn emits constantly while a wedged one emits nothing, so only silence
// tells them apart; a wall clock alone charges the full cap every time and
// still cannot say which happened. A team member is an ordinary run, so the
// same reasoning applies one level up: a member that is working writes things
// down (run events, mailbox messages, task transitions) and a member that has
// died writes nothing.
//
// The second half is why there is no heartbeat writer. Adding one would mean a
// new periodic write from the dispatcher describing liveness that four
// existing tables already describe — and it would be *more* wrong than they
// are, because a heartbeat loop keeps ticking inside a process whose agent is
// wedged. That is exactly the failure R3.5 exists to catch. So the heartbeat
// is a query over evidence somebody else already had to write, and only the
// conclusion ("this slot is lost") is stored.
//
// WHAT COUNTS AS A SIGN OF LIFE, and why each one is here:
//   * the newest event of the slot's live run — the finest-grained signal
//     there is, flushed continuously during a turn rather than at settle
//     (lib/dispatcher/worker.ts batches at 50 events or on a timer);
//   * `runs.updated_at` across the slot's runs — moves on lease renewal and on
//     settle, so it still answers for a run whose transcript is gone;
//   * the last message the slot sent to the team;
//   * the last time it moved a task it owns.
// Anything the slot did leaves at least one of these, and none of them can be
// produced by a slot that is not there.
import { createHash } from 'node:crypto'
import { bestEffort } from '@/lib/failures'
import { getBrokerPool, releaseTeamTask, type TeamMember, type TeamMessage, type TeamRole } from '@/lib/broker'

/**
 * How long a slot may say nothing before the room stops believing in it.
 *
 * The default is the same 120s the runtime's own inactivity watchdog uses
 * (`inactivityTimeoutMs` in `lib/hermes/acp-client.ts` defaults to
 * `min(120_000, turnTimeoutMs)`). Deliberately not a new number: a slot that
 * has been silent longer than the runtime itself would tolerate is silent by
 * the strictest measure already in the codebase, so this can never be the
 * component that cries wolf first.
 *
 * Overridable because the right value depends on the model and the machine,
 * and a constant nobody can change becomes a constant everybody works around.
 */
export const TEAM_SILENCE_MS = (() => {
  const raw = Number(process.env.TEAM_SLOT_SILENCE_MS)
  return Number.isFinite(raw) && raw >= 15_000 ? raw : 120_000
})()

/** Non-terminal run statuses. Duplicated from the several places in
 * `lib/broker/runs.ts` that spell the same set out inline; there is no
 * exported constant for it and adding one would mean editing a file this unit
 * does not own. */
const LIVE_RUN_STATUSES = "('queued', 'dispatched', 'running', 'waiting_directory')"

/** Statuses that mean a slot is actually holding work. `blocked` is excluded:
 * a blocked task is waiting on the graph, not on its owner, and taking it away
 * from a member that is correctly waiting would be the watchdog creating the
 * churn it exists to prevent. */
const HELD_TASK_STATUSES = "('claimed', 'in_progress')"

export type TeamSlotState =
  | 'lost'
  | 'awaiting_approval'
  | 'awaiting_directory'
  | 'running'
  | 'queued'
  | 'silent'
  | 'idle'

export interface TeamSlotHealth {
  slotId: number
  displayName: string
  /** ISO, or null when nothing has ever been observed for this slot. */
  lastSeenAt: string | null
  /** Milliseconds of silence, or null when there is no baseline to measure
   * from. Null is not zero and must not be rendered as "just now". */
  silentForMs: number | null
  lostAt: string | null
  lostReason: string | null
  /** The value already materialised on the row, kept so the sweep can skip a
   * write that would not change anything (see `persistLastSeen`). */
  storedLastSeenAt: string | null
  activeRunId: number | null
  activeRunStatus: string | null
  /** Pending approval cards raised by this slot's live run. Non-zero means the
   * slot is blocked on a PERSON, which is the one kind of silence that must
   * never be read as death. */
  pendingApprovals: number
  /** Tasks this slot is holding right now — what a lost verdict would return
   * to the board. */
  heldTaskIds: number[]
  state: TeamSlotState
}

export interface TeamStopState {
  requestedAt: string | null
  requestedBy: number | null
  /** In-flight runs across the whole room, right now. */
  inFlightRunIds: number[]
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toNumberArray(value: any): number[] {
  return Array.isArray(value) ? value.filter((v) => v != null).map(Number) : []
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Every slot's liveness, in ONE query.
 *
 * Three lateral joins rather than a chain of round trips, because this runs on
 * the room's poll and on its first render (D0). Each lateral is bounded by
 * something small: the newest live run for the session, the tasks that one
 * slot holds, the newest message it sent.
 *
 * The live run's freshest event is read as `ORDER BY seq DESC LIMIT 1`, not
 * `MAX(created_at)`. `run_messages` is indexed on `(run_id, seq)` and `seq` is
 * assigned monotonically per run before insert, so this is a one-row backward
 * index scan; `MAX(created_at)` has no index to use and would read every event
 * of a long turn on every poll — a scan that grows with the transcript, on the
 * hot path, to answer a question one row already answers.
 *
 * Historical runs contribute only `MAX(runs.updated_at)`, not their
 * transcripts. `settleRun` drains the write buffer before it settles (see the
 * worker's `flushWrites()` before every terminal transition), so a settled
 * run's `updated_at` is never older than its last event — the cheap column is
 * as good an answer as the expensive scan.
 */
export async function readTeamSlotHealth(teamId: number): Promise<TeamSlotHealth[]> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `SELECT m.id                AS slot_id,
            m.display_name      AS display_name,
            m.lost_at           AS lost_at,
            m.lost_reason       AS lost_reason,
            m.last_seen_at      AS stored_last_seen_at,
            live.run_id         AS run_id,
            live.run_status     AS run_status,
            live.pending_approvals AS pending_approvals,
            held.held_ids       AS held_ids,
            -- GREATEST ignores NULLs in Postgres, so a slot with only some of
            -- these signals still resolves to its newest one rather than to
            -- NULL. The stored last_seen_at is included so a materialised value can
            -- never go backwards when the run rows behind it are reclaimed.
            GREATEST(
              m.last_seen_at,
              live.last_event_at,
              runs_any.last_run_at,
              held.last_task_at,
              msg.last_message_at
            ) AS last_seen_at
       FROM team_members m
       LEFT JOIN LATERAL (
         SELECT r.id AS run_id,
                r.status AS run_status,
                (SELECT rm.created_at FROM run_messages rm
                  WHERE rm.run_id = r.id ORDER BY rm.seq DESC LIMIT 1) AS last_event_at,
                (SELECT COUNT(*) FROM approvals a
                  WHERE a.run_id = r.id AND a.status = 'pending') AS pending_approvals
           FROM runs r
          WHERE r.session_id = m.session_id
            AND r.status IN ${LIVE_RUN_STATUSES}
          ORDER BY r.id DESC
          LIMIT 1
       ) live ON TRUE
       LEFT JOIN LATERAL (
         SELECT MAX(r2.updated_at) AS last_run_at
           FROM runs r2 WHERE r2.session_id = m.session_id
       ) runs_any ON TRUE
       LEFT JOIN LATERAL (
         SELECT ARRAY_AGG(t.id ORDER BY t.id) AS held_ids, MAX(t.updated_at) AS last_task_at
           FROM team_tasks t
          WHERE t.owner_slot_id = m.id AND t.status IN ${HELD_TASK_STATUSES}
       ) held ON TRUE
       LEFT JOIN LATERAL (
         SELECT MAX(g.created_at) AS last_message_at
           FROM team_messages g WHERE g.from_slot_id = m.id
       ) msg ON TRUE
      WHERE m.team_id = $1
      ORDER BY (m.role = 'leader') DESC, m.id`,
    [teamId],
  )

  const now = Date.now()
  return rows.map((row) => {
    const lastSeen = row.last_seen_at ? new Date(row.last_seen_at) : null
    const silentForMs = lastSeen ? Math.max(0, now - lastSeen.getTime()) : null
    const pendingApprovals = Number(row.pending_approvals ?? 0)
    const heldTaskIds = toNumberArray(row.held_ids)
    const runStatus: string | null = row.run_status ?? null
    const lostAt = row.lost_at ? new Date(row.lost_at).toISOString() : null

    // Order matters: the reasons a slot is quiet are checked before the fact
    // that it is quiet. A member waiting on an approval card, or on somebody
    // to pick a directory, is silent for a reason the room already knows.
    let state: TeamSlotState = 'idle'
    if (lostAt) state = 'lost'
    else if (pendingApprovals > 0) state = 'awaiting_approval'
    else if (runStatus === 'waiting_directory') state = 'awaiting_directory'
    else if (runStatus === 'queued') state = 'queued'
    else if (silentForMs != null && silentForMs > TEAM_SILENCE_MS && (runStatus != null || heldTaskIds.length > 0))
      state = 'silent'
    else if (runStatus != null) state = 'running'

    return {
      slotId: Number(row.slot_id),
      displayName: row.display_name,
      lastSeenAt: lastSeen ? lastSeen.toISOString() : null,
      storedLastSeenAt: row.stored_last_seen_at ? new Date(row.stored_last_seen_at).toISOString() : null,
      silentForMs,
      lostAt,
      lostReason: row.lost_reason ?? null,
      activeRunId: row.run_id == null ? null : Number(row.run_id),
      activeRunStatus: runStatus,
      pendingApprovals,
      heldTaskIds,
      state,
    }
  })
}

/**
 * Resolves a slot for an authenticated tool call AND records the heartbeat, in
 * one round trip on the path that matters.
 *
 * A tool call is the strongest proof of life a slot can give: it is the slot's
 * own process, holding the run's own token, doing work. Deriving liveness from
 * run events alone would miss a member that is talking to the board but not
 * emitting to its transcript, and it would keep a wedged-then-recovered slot
 * marked lost for a whole silence window after it came back.
 *
 * The heartbeat is folded into the authorisation read rather than added after
 * it, so the common case costs no extra query at all: `UPDATE … WHERE id = $1
 * AND agent_id = $2 RETURNING *` both proves the run's agent fills this slot
 * and stamps `last_seen_at`. Only the refused case pays a second query, to tell
 * "no such slot" apart from "not your slot" — the two must stay
 * distinguishable in the caller's message, and a caller who fails this check
 * must not be able to make a slot look alive by knocking on it.
 *
 * `lost_at` is deliberately NOT cleared here. Recovery is announced in the room
 * by `sweepTeamSlots`, and clearing the flag silently would make a member come
 * back from the dead with nobody told — which is the same class of bug as a
 * task settled with no report.
 */
export async function touchAndReadTeamSlot(
  slotId: number,
  runAgentId: number | null,
): Promise<{ slot: TeamMember | null; heartbeat: boolean }> {
  const pool = getBrokerPool()
  if (runAgentId != null) {
    const { rows } = await pool.query(
      `UPDATE team_members SET last_seen_at = now() WHERE id = $1 AND agent_id = $2 RETURNING *`,
      [slotId, runAgentId],
    )
    if (rows[0]) return { slot: toMember(rows[0]), heartbeat: true }
  }
  const { rows } = await pool.query(`SELECT * FROM team_members WHERE id = $1`, [slotId])
  return { slot: rows[0] ? toMember(rows[0]) : null, heartbeat: false }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Mirrors `lib/broker/teams.ts`'s own mapper. Duplicated rather than exported
 * from there because that file belongs to another unit; it is checked against
 * the same columns by `TeamMember`'s type. */
function toMember(row: any): TeamMember {
  return {
    id: Number(row.id),
    teamId: Number(row.team_id),
    agentId: Number(row.agent_id),
    role: row.role as TeamRole,
    displayName: row.display_name,
    colour: row.colour,
    sessionId: row.session_id == null ? null : Number(row.session_id),
    worktreeId: row.worktree_id == null ? null : Number(row.worktree_id),
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface TeamSweepResult {
  health: TeamSlotHealth[]
  /** Slots newly declared lost by THIS sweep. */
  lostSlotIds: number[]
  /** Slots that had been lost and have since spoken. */
  recoveredSlotIds: number[]
  /** Tasks handed back to the board. */
  releasedTaskIds: number[]
}

/**
 * Finds silent slots, hands their work back, and says so in the room.
 *
 * Returning the task to the board is the whole point — `team_tasks.owner_slot_id`
 * stays set through every other failure path, and a `claimed` task with an
 * absent owner is a dead end: `claimableTasks` and `claimTeamTask` both require
 * `owner_slot_id IS NULL`, so nobody can ever pick it up again. That is why
 * this calls `releaseTeamTask` (which clears the owner AND the status together)
 * rather than flipping a status.
 *
 * THREE SUPPRESSIONS, each one a case where silence is explained:
 *
 *  1. a pending approval card — the member is blocked on a human, and killing
 *     its claim while somebody is deciding would return the task to the board
 *     and then approve work nobody owns;
 *  2. `waiting_directory` — same shape, a different human decision;
 *  3. a room-wide stop inside the grace window — a person just told the room to
 *     go quiet, and a watchdog that reports its own instruction back as a fault
 *     is not a watchdog. The window is bounded by the silence threshold: after
 *     that, a stopped room whose members were never restarted really has
 *     abandoned its tasks, and the board should say so.
 */
export async function sweepTeamSlots(teamId: number): Promise<TeamSweepResult> {
  const pool = getBrokerPool()
  const [health, stop] = await Promise.all([readTeamSlotHealth(teamId), readTeamStopState(teamId, { runs: false })])

  const stopGrace =
    stop.requestedAt != null && Date.now() - new Date(stop.requestedAt).getTime() < TEAM_SILENCE_MS

  const lostSlotIds: number[] = []
  const recoveredSlotIds: number[] = []
  const releasedTaskIds: number[] = []

  for (const slot of health) {
    const explained = slot.pendingApprovals > 0 || slot.activeRunStatus === 'waiting_directory' || stopGrace
    const silent = slot.silentForMs != null && slot.silentForMs > TEAM_SILENCE_MS
    // A slot with nothing in flight and nothing assigned cannot be "lost":
    // there is no work to reclaim and no promise being broken. Marking every
    // idle roster entry lost the moment a team is created would make the state
    // meaningless, which is the failure mode R6.6 warns about — a badge that
    // is always on is bookkeeping, not reliability.
    const accountable = slot.heldTaskIds.length > 0 || slot.activeRunId != null

    if (slot.lostAt == null && silent && accountable && !explained) lostSlotIds.push(slot.slotId)
    else if (slot.lostAt != null && !silent) recoveredSlotIds.push(slot.slotId)
  }

  const bySlot = new Map(health.map((h) => [h.slotId, h]))

  for (const slotId of lostSlotIds) {
    const slot = bySlot.get(slotId)!
    const seconds = Math.round((slot.silentForMs ?? 0) / 1000)
    const reason =
      `Nothing heard for ${seconds}s — no run events, no messages, no task activity. ` +
      (slot.activeRunId != null
        ? `Its run ${slot.activeRunId} is still marked '${slot.activeRunStatus}' but has gone quiet.`
        : 'It has no run in flight.')

    // `lost_at IS NULL` in the WHERE, not just in the calling code: two rooms
    // open in two tabs both sweep, and only one of them may announce it.
    const marked = await pool.query(
      `UPDATE team_members
          SET lost_at = now(), lost_reason = $2, updated_at = now()
        WHERE id = $1 AND team_id = $3 AND lost_at IS NULL
        RETURNING id`,
      [slotId, reason, teamId],
    )
    if (marked.rowCount === 0) {
      // Somebody else got there first; do not release its tasks twice and do
      // not post a second announcement.
      lostSlotIds.splice(lostSlotIds.indexOf(slotId), 1)
      continue
    }

    const handedBack = slot.heldTaskIds
    for (const taskId of handedBack) {
      await releaseTeamTask(taskId)
      releasedTaskIds.push(taskId)
    }
    slot.lostAt = new Date().toISOString()
    slot.lostReason = reason
    slot.state = 'lost'
    slot.heldTaskIds = []

    await writeSystemMessage(teamId, 'slot_lost', {
      body:
        `"${slot.displayName}" went silent. ${reason} ` +
        (handedBack.length > 0
          ? `Task${handedBack.length === 1 ? '' : 's'} ${handedBack.join(', ')} returned to the board, so any ` +
            `idle member can pick ${handedBack.length === 1 ? 'it' : 'them'} up.`
          : 'It was holding no tasks, so nothing was returned to the board.'),
      taskId: handedBack.length === 1 ? handedBack[0] : null,
    })
  }

  for (const slotId of recoveredSlotIds) {
    const slot = bySlot.get(slotId)!
    const cleared = await pool.query(
      `UPDATE team_members SET lost_at = NULL, lost_reason = NULL, updated_at = now()
        WHERE id = $1 AND team_id = $2 AND lost_at IS NOT NULL RETURNING id`,
      [slotId, teamId],
    )
    if (cleared.rowCount === 0) {
      recoveredSlotIds.splice(recoveredSlotIds.indexOf(slotId), 1)
      continue
    }
    slot.lostAt = null
    slot.lostReason = null
    slot.state = slot.activeRunId != null ? 'running' : 'idle'
    await writeSystemMessage(teamId, 'slot_recovered', {
      body:
        `"${slot.displayName}" is answering again. Anything it was holding when it went silent was returned to ` +
        `the board and may now belong to somebody else — it should re-read the board before continuing.`,
    })
  }

  await persistLastSeen(teamId, health)
  return { health, lostSlotIds, recoveredSlotIds, releasedTaskIds }
}

/**
 * Materialises the derived heartbeat, but only when it has moved appreciably.
 *
 * The room polls every six seconds. Writing every slot's `last_seen_at` on
 * every poll would be a continuous write load whose only purpose is to survive
 * the eventual loss of the rows it was derived from. The 30-second floor makes
 * that write rare while keeping the stored value within half a minute of the
 * truth, which is far finer than the two minutes any decision here uses.
 *
 * One statement for the whole roster — an `UPDATE ... FROM (VALUES …)` — not
 * one per slot.
 */
async function persistLastSeen(teamId: number, health: TeamSlotHealth[]): Promise<void> {
  // Filtered here rather than only in the WHERE clause, so the common case —
  // a poll where nothing moved — costs no round trip at all instead of an
  // UPDATE that matches nothing. The room polls every six seconds; a query
  // that is always issued and almost never does anything is exactly the kind
  // of idle cost D0 rules out.
  const rows = health.filter(
    (h) =>
      h.lastSeenAt != null &&
      (h.storedLastSeenAt == null ||
        new Date(h.lastSeenAt).getTime() > new Date(h.storedLastSeenAt).getTime() + 30_000),
  )
  if (rows.length === 0) return
  const pool = getBrokerPool()
  const values = rows.map((_, i) => `($${i * 2 + 2}::bigint, $${i * 2 + 3}::timestamptz)`).join(', ')
  const params: unknown[] = [teamId]
  for (const row of rows) params.push(row.slotId, row.lastSeenAt)
  await pool.query(
    `UPDATE team_members m
        SET last_seen_at = v.seen
       FROM (VALUES ${values}) AS v(slot_id, seen)
      WHERE m.id = v.slot_id
        AND m.team_id = $1
        AND (m.last_seen_at IS NULL OR v.seen > m.last_seen_at + interval '30 seconds')`,
    params,
  )
}

/** The room's own voice: `from_slot_id IS NULL` with a `system_kind`, so the
 * feed can tell it from a human's message (which is NULL with no kind) and
 * from a member's (which now keeps its slot id even after removal). */
async function writeSystemMessage(
  teamId: number,
  systemKind: string,
  input: { body: string; taskId?: number | null },
): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(
    `INSERT INTO team_messages (team_id, from_slot_id, to_slot_id, kind, body, task_id, system_kind)
     VALUES ($1, NULL, NULL, 'status', $2, $3, $4)`,
    [teamId, input.body, input.taskId ?? null, systemKind],
  )
}

// --- The room-wide stop ------------------------------------------------------

export interface TeamInFlightRun {
  runId: number
  slotId: number
  displayName: string
  status: string
}

/**
 * Every member turn currently in flight, in one query.
 *
 * The join is `runs.session_id = team_members.session_id`, the same and only
 * link `getTeamBindingForSession` uses — a run carries a session, a slot
 * carries a session, and nothing carries a slot id.
 */
export async function listTeamRunsInFlight(teamId: number): Promise<TeamInFlightRun[]> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `SELECT r.id AS run_id, m.id AS slot_id, m.display_name, r.status
       FROM team_members m
       JOIN runs r ON r.session_id = m.session_id
      WHERE m.team_id = $1
        AND r.status IN ${LIVE_RUN_STATUSES}
      ORDER BY r.id`,
    [teamId],
  )
  return rows.map((row) => ({
    runId: Number(row.run_id),
    slotId: Number(row.slot_id),
    displayName: row.display_name,
    status: row.status,
  }))
}

export async function readTeamStopState(
  teamId: number,
  options: { runs?: boolean } = {},
): Promise<TeamStopState> {
  const pool = getBrokerPool()
  // `teams.stop_requested_at` is read here rather than through `getTeam`
  // because `lib/broker/teams.ts`'s row mapper does not carry the column and
  // that file belongs to another unit.
  const { rows } = await pool.query(
    `SELECT stop_requested_at, stop_requested_by FROM teams WHERE id = $1`,
    [teamId],
  )
  const row = rows[0]
  const inFlight = options.runs === false ? [] : (await listTeamRunsInFlight(teamId)).map((r) => r.runId)
  return {
    requestedAt: row?.stop_requested_at ? new Date(row.stop_requested_at).toISOString() : null,
    requestedBy: row?.stop_requested_by == null ? null : Number(row.stop_requested_by),
    inFlightRunIds: inFlight,
  }
}

/**
 * Records that a human stopped the whole room, and says so in the feed.
 *
 * This records ONLY; the actual cancellation is `requestRunCancellation` /
 * `requestRunCancel` per run, which is the mechanism migration 0010 already
 * built and the one the worker already watches. Inventing a second path — a
 * team-level cancel flag the worker would have to learn to poll — is exactly
 * what R6.6 forbids, and it would fail the same way the pre-0010 in-process Map
 * failed: unread by whichever process is actually holding the turn.
 */
export async function recordTeamStopRequest(input: {
  teamId: number
  requestedBy: number | null
  runIds: number[]
}): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(
    `UPDATE teams SET stop_requested_at = now(), stop_requested_by = $2, updated_at = now() WHERE id = $1`,
    [input.teamId, input.requestedBy],
  )
  await writeSystemMessage(input.teamId, 'room_stop', {
    body:
      input.runIds.length === 0
        ? 'A room-wide stop was requested. No member turn was in flight, so nothing was interrupted.'
        : `A room-wide stop was requested. ${input.runIds.length} member turn${
            input.runIds.length === 1 ? '' : 's'
          } asked to stop cooperatively (run${input.runIds.length === 1 ? '' : 's'} ${input.runIds.join(', ')}). ` +
          'Everything already streamed is kept; tasks stay assigned unless a member then goes silent.',
  })
}

/** Clears the stop mark. Called when the room is used again, so the banner and
 * the sweep's grace window do not outlive the pause they describe. */
export async function clearTeamStopRequest(teamId: number): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(
    `UPDATE teams SET stop_requested_at = NULL, stop_requested_by = NULL, updated_at = now()
      WHERE id = $1 AND stop_requested_at IS NOT NULL`,
    [teamId],
  )
}

// --- Messages, with the two facts `lib/broker`'s mapper cannot carry ---------

export interface TeamRoomMessage extends TeamMessage {
  /** Set when this row was written by the room itself rather than by a person
   * or a slot: 'slot_lost' | 'slot_recovered' | 'room_stop' | 'dead_letter'. */
  systemKind: string | null
  /** Set when the addressee was removed before reading it. Such a row is NOT a
   * broadcast — see migration 0012 — and the feed must not render it as one. */
  undeliverableAt: string | null
  undeliverableReason: string | null
  /** True when `toSlotId` points at a slot that no longer exists. Computed by
   * the caller against the live roster rather than stored, because a removal
   * that happens between two polls must not need a backfill to become visible. */
  addresseeMissing: boolean
}

/**
 * The room's feed, carrying the reliability columns.
 *
 * `listTeamMessages` in `lib/broker/teams.ts` answers the same question but its
 * row mapper predates these columns, and that file belongs to another unit. The
 * query below is the same range scan on the same `(team_id, id)` index.
 */
export async function listTeamRoomMessages(
  teamId: number,
  options: { limit?: number; since?: number } = {},
): Promise<TeamRoomMessage[]> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `SELECT g.*, (g.to_slot_id IS NOT NULL AND m.id IS NULL) AS addressee_missing
       FROM team_messages g
       LEFT JOIN team_members m ON m.id = g.to_slot_id
      WHERE g.team_id = $1 AND g.id > $2
      ORDER BY g.id
      LIMIT $3`,
    [teamId, options.since ?? 0, Math.min(options.limit ?? 200, 1000)],
  )
  return rows.map(toRoomMessage)
}

/** Dead letters only — what the room shows when somebody asks "did anything
 * get lost when I removed that member?". */
export async function listTeamDeadLetters(teamId: number, limit = 50): Promise<TeamRoomMessage[]> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `SELECT g.*, TRUE AS addressee_missing
       FROM team_messages g
      WHERE g.team_id = $1 AND g.undeliverable_at IS NOT NULL
      ORDER BY g.id DESC
      LIMIT $2`,
    [teamId, Math.min(limit, 200)],
  )
  return rows.map(toRoomMessage)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toRoomMessage(row: any): TeamRoomMessage {
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
    systemKind: row.system_kind ?? null,
    undeliverableAt: row.undeliverable_at ? new Date(row.undeliverable_at).toISOString() : null,
    undeliverableReason: row.undeliverable_reason ?? null,
    addresseeMissing: row.addressee_missing === true,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// --- Idempotency -------------------------------------------------------------

export interface TeamToolCallKey {
  teamId: number
  slotId: number
  /** The tool's own name, so two tools can never share a record. */
  tool: string
  /** The task this call is about, or null for a call that names none. R6.6
   * asks for idempotency "by task and slot"; both are part of the key. */
  taskId?: number | null
  /** Everything else that makes this a DIFFERENT call. Two calls with the same
   * key but different arguments must NOT be deduplicated — that would turn
   * idempotency into silent data loss. */
  args?: Record<string, unknown>
  /**
   * Optional repeat window, in milliseconds.
   *
   * Some calls may legitimately be made again with identical arguments later:
   * a member can move a task to `in_progress`, be blocked, and move it back;
   * it can send the same one-line status twice an hour apart. Folding a coarse
   * time bucket into the fingerprint keeps a RETRY (seconds later, same
   * bucket) deduplicated while letting a genuine repeat (a later bucket)
   * through.
   *
   * HONEST LIMIT: a retry that straddles a bucket boundary is not caught. That
   * is why the irreversible calls — creating a task, claiming one, reporting
   * one done — pass no window at all and are deduplicated forever; only the
   * repeatable ones are bucketed, and the worst case there is a duplicate line
   * in an append-only feed that everybody can see.
   */
  repeatWindowMs?: number
}

/** Stable across key order, so `{a,b}` and `{b,a}` fingerprint identically —
 * an agent's tool arguments arrive as JSON and their order is not something we
 * get to depend on. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

function fingerprintOf(key: TeamToolCallKey): string {
  const bucket =
    key.repeatWindowMs && key.repeatWindowMs > 0 ? Math.floor(Date.now() / key.repeatWindowMs) : 'always'
  return createHash('sha256').update(`${bucket}|${stableStringify(key.args ?? {})}`).digest('hex')
}

/**
 * Runs a tool's effect at most once per (slot, tool, task, arguments).
 *
 * Two phases, deliberately. A record written only after the work succeeds
 * dedupes the easy case — a retry that arrives once the first call has
 * finished — and misses the one that actually corrupts a board: a duplicate
 * arriving while the first is still running, which is precisely what a client
 * timeout produces. Reserving first turns that into a refusal instead of a
 * second claim.
 *
 * A FAILED call deletes its reservation. Idempotency must not make an error
 * permanent: if the first attempt threw, the agent's retry is a real retry and
 * has to be allowed to run.
 *
 * Cost is two small indexed writes around each mutating call. That is paid on
 * an agent's tool call — already several queries and an HTTP round trip — and
 * it buys the difference between a board that can be double-booked and one
 * that cannot.
 */
export async function runTeamToolOnce(key: TeamToolCallKey, effect: () => Promise<string>): Promise<string> {
  const pool = getBrokerPool()
  const fingerprint = fingerprintOf(key)
  const taskId = key.taskId ?? null

  const reserved = await pool.query(
    `INSERT INTO team_tool_calls (team_id, slot_id, tool, task_id, fingerprint)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [key.teamId, key.slotId, key.tool, taskId, fingerprint],
  )

  if (reserved.rowCount === 0) {
    const { rows } = await pool.query(
      `SELECT status, result FROM team_tool_calls
        WHERE slot_id = $1 AND tool = $2 AND COALESCE(task_id, -1) = COALESCE($3::bigint, -1) AND fingerprint = $4`,
      [key.slotId, key.tool, taskId, fingerprint],
    )
    const prior = rows[0]
    // Replayed VERBATIM. Any other answer — "already done", a fresh read of
    // the row — would be a different response to the same request, which is
    // the thing idempotency is for.
    if (prior?.status === 'done' && typeof prior.result === 'string') return prior.result

    // THE RESERVATION IS A LEASE, NOT A TOMBSTONE.
    //
    // The `catch` below deletes the reservation when the effect THROWS, which
    // covers a call that failed. It cannot cover a call that never returned at
    // all: a SIGKILL, a deploy, an OOM, or a serverless instance reclaimed
    // mid-request leaves `status = 'in_progress'` with no process left to
    // settle or delete it. Without a lease that row is permanent, and because
    // the irreversible tools (`team_create_task`, `team_claim_task`,
    // `team_report_done`) pass no `repeatWindowMs` and are deduplicated
    // forever, a single crash would mean that exact call can NEVER succeed
    // again — the agent retries and is told "already in flight" for the life of
    // the installation. Idempotency must not be able to make a call
    // permanently impossible; that is a worse failure than the double-write it
    // exists to prevent.
    //
    // The window is TEAM_SILENCE_MS, and deliberately the same number: it is
    // already the point at which this file stops believing the SLOT is alive.
    // A tool call belonging to a slot we would by then declare lost cannot
    // still be meaningfully "in flight", so a second threshold would be a
    // second answer to one question. It is also far longer than any effect
    // here — these are a handful of indexed statements — so a genuinely
    // running call is never stolen from.
    //
    // The takeover is the UPDATE itself, not a read followed by a write: the
    // `status`/`created_at` test lives in the WHERE clause, so of two agents
    // retrying the same wedged call at once exactly one row is returned and
    // exactly one runs the effect. Stamping `created_at = now()` restarts the
    // lease, so a process that dies while holding the takeover is itself
    // recovered from a window later rather than wedging the row again.
    const takenOver = await pool.query(
      `UPDATE team_tool_calls SET created_at = now()
        WHERE slot_id = $1 AND tool = $2 AND COALESCE(task_id, -1) = COALESCE($3::bigint, -1)
          AND fingerprint = $4 AND status = 'in_progress'
          AND created_at < now() - ($5::double precision * interval '1 millisecond')
        RETURNING id`,
      [key.slotId, key.tool, taskId, fingerprint, TEAM_SILENCE_MS],
    )
    if (takenOver.rowCount === 0) {
      return JSON.stringify(
        {
          duplicate: true,
          message:
            `An identical ${key.tool} call from this slot is already in flight. It was NOT run a second time. ` +
            `Wait for the first one, then read the board or your inbox to see what it did.`,
        },
        null,
        2,
      )
    }
    // Fall through: this call now holds the lease and runs the effect itself.
  }

  try {
    const result = await effect()
    await pool.query(
      `UPDATE team_tool_calls SET status = 'done', result = $2, completed_at = now()
        WHERE slot_id = $1 AND tool = $3 AND COALESCE(task_id, -1) = COALESCE($4::bigint, -1) AND fingerprint = $5`,
      [key.slotId, result, key.tool, taskId, fingerprint],
    )
    return result
  } catch (err) {
    await bestEffort(
      pool.query(
        `DELETE FROM team_tool_calls
          WHERE slot_id = $1 AND tool = $2 AND COALESCE(task_id, -1) = COALESCE($3::bigint, -1)
            AND fingerprint = $4 AND status = 'in_progress'`,
        [key.slotId, key.tool, taskId, fingerprint],
      ),
      'the tool call already failed; leaving its in-progress row behind is better than replacing that failure with this one',
      { slotId: key.slotId, tool: key.tool, taskId },
    )
    throw err
  }
}

// ---------------------------------------------------------------------------
// WHAT THIS UNIT COULD NOT DO, AND WHY
// ---------------------------------------------------------------------------
//
// THE SWEEP HAS NO BACKGROUND HOME. `sweepTeamSlots` is called from the Teams
// room — on first render and on its six-second poll — so a lost slot is
// detected and its task returned to the board within seconds of anyone looking
// at the room. Nobody looking means nobody detecting: a team whose members all
// die overnight will show its tasks reclaimed the next time the page is
// opened, not at 3am. The correct home is one line in the dispatcher tick
// (`app/api/dispatcher/tick/route.ts`, which already runs `sweepExpiredLeases`
// on a cadence) calling `sweepTeamSlots` for every team with a live run or a
// held task. That route is not in this unit's owned paths, so it is described
// here rather than half-built: the sweep itself is idempotent, concurrency-safe
// (every transition is guarded in its own WHERE clause) and takes only a team
// id, so wiring it there is genuinely a one-line change.
//
// A SLOT'S RUNS ARE FOUND THROUGH ITS SESSION. Everything here joins
// `runs.session_id = team_members.session_id`, inheriting the ambiguity
// `lib/teams/tools.ts` already documents: two slots of the same agent sharing a
// session are indistinguishable. Every slot created through `createSlot` gets
// its own session, so this is not reachable through the UI, but a
// `runs.team_slot_id` column would close it properly — a migration plus a
// change to every enqueue site, in units this one does not own.

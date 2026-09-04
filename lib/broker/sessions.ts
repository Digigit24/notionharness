// Chat sessions — the durable thread a Work conversation actually is.
//
// See `migrations/0007_sessions_and_worktrees.sql` for why this exists and
// why the table is `chat_sessions` rather than `sessions`. In short: a
// conversation used to be an emergent grouping over `runs` keyed by agent,
// which allowed exactly one thread per agent and forced continuity to be
// faked by replaying transcript text into every prompt.
//
// Raw `pg`, matching every other module in `lib/broker` — this is the
// operational data plane, not Payload-managed content.
import { getBrokerPool } from './db'
import { rowToRun as runRowToRun } from './runs'
import type { Run } from './types'

export interface ChatSession {
  id: number
  workspaceId: number
  agentId: number
  projectId: number | null
  worktreeId: number | null
  title: string
  titleSource: 'auto' | 'user'
  hermesSessionId: string | null
  createdBy: number | null
  createdAt: string
  updatedAt: string
  lastActivityAt: string
  archivedAt: string | null
  pinned: boolean
}

interface SessionRow {
  id: string | number
  workspace_id: string | number
  agent_id: string | number
  project_id: string | number | null
  worktree_id: string | number | null
  title: string
  title_source: string
  hermes_session_id: string | null
  created_by: string | number | null
  created_at: Date
  updated_at: Date
  last_activity_at: Date
  archived_at: Date | null
  pinned: boolean
}

function rowToSession(row: SessionRow): ChatSession {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    agentId: Number(row.agent_id),
    projectId: row.project_id === null ? null : Number(row.project_id),
    worktreeId: row.worktree_id === null ? null : Number(row.worktree_id),
    title: row.title,
    titleSource: row.title_source === 'user' ? 'user' : 'auto',
    hermesSessionId: row.hermes_session_id,
    createdBy: row.created_by === null ? null : Number(row.created_by),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    pinned: row.pinned,
  }
}

const COLUMNS = `id, workspace_id, agent_id, project_id, worktree_id, title, title_source,
                 hermes_session_id, created_by, created_at, updated_at, last_activity_at,
                 archived_at, pinned`

export async function createSession(input: {
  workspaceId: number
  agentId: number
  projectId?: number | null
  worktreeId?: number | null
  title?: string
  createdBy?: number | null
}): Promise<ChatSession> {
  const pool = getBrokerPool()
  const res = await pool.query<SessionRow>(
    `INSERT INTO chat_sessions (workspace_id, agent_id, project_id, worktree_id, title, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [
      input.workspaceId,
      input.agentId,
      input.projectId ?? null,
      input.worktreeId ?? null,
      input.title ?? '',
      input.createdBy ?? null,
    ],
  )
  return rowToSession(res.rows[0])
}

export async function getSession(id: number): Promise<ChatSession | null> {
  const pool = getBrokerPool()
  const res = await pool.query<SessionRow>(`SELECT ${COLUMNS} FROM chat_sessions WHERE id = $1`, [id])
  return res.rows[0] ? rowToSession(res.rows[0]) : null
}

export interface SessionListItem extends ChatSession {
  /** Denormalised for the rail, which would otherwise need one query per row. */
  agentName: string | null
  projectName: string | null
  runCount: number
  /** True when this session has a run that has not reached a terminal state. */
  isRunning: boolean
  /** First words of the most recent user prompt — the rail's subtitle. */
  preview: string | null
}

/**
 * The session rail's query. One statement, because this runs on every Work
 * page load and the rail is the first thing painted: a per-row follow-up
 * query would put the list behind N round-trips to a remote database.
 */
export async function listSessions(options: {
  workspaceId: number
  agentId?: number | null
  projectId?: number | null
  includeArchived?: boolean
  limit?: number
}): Promise<SessionListItem[]> {
  const pool = getBrokerPool()
  const conditions = ['s.workspace_id = $1']
  const params: unknown[] = [options.workspaceId]
  if (options.agentId != null) {
    params.push(options.agentId)
    conditions.push(`s.agent_id = $${params.length}`)
  }
  if (options.projectId != null) {
    params.push(options.projectId)
    conditions.push(`s.project_id = $${params.length}`)
  }
  if (!options.includeArchived) conditions.push('s.archived_at IS NULL')
  params.push(options.limit ?? 200)

  const res = await pool.query(
    `SELECT ${COLUMNS.split(',').map((c) => `s.${c.trim()}`).join(', ')},
            a.name AS agent_name,
            p.name AS project_name,
            COALESCE(r.run_count, 0)::int AS run_count,
            COALESCE(r.is_running, false) AS is_running,
            r.preview
       FROM chat_sessions s
       LEFT JOIN agents a ON a.id = s.agent_id
       LEFT JOIN projects p ON p.id = s.project_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS run_count,
                bool_or(status NOT IN ('completed', 'failed', 'cancelled')) AS is_running,
                (ARRAY_AGG(prompt ORDER BY id DESC) FILTER (WHERE prompt IS NOT NULL))[1] AS preview
           FROM runs
          WHERE runs.session_id = s.id
       ) r ON true
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.pinned DESC, s.last_activity_at DESC
      LIMIT $${params.length}`,
    params,
  )
  return res.rows.map((row) => ({
    ...rowToSession(row as SessionRow),
    agentName: (row as { agent_name: string | null }).agent_name,
    projectName: (row as { project_name: string | null }).project_name,
    runCount: (row as { run_count: number }).run_count,
    isRunning: (row as { is_running: boolean }).is_running,
    preview: (row as { preview: string | null }).preview,
  }))
}

/** Runs belonging to one session, oldest first — the thread's own order. */
export async function listRunsForSession(sessionId: number): Promise<Run[]> {
  const pool = getBrokerPool()
  const res = await pool.query(`SELECT * FROM runs WHERE session_id = $1 ORDER BY id ASC`, [sessionId])
  return res.rows.map(runRowToRun)
}

export async function touchSession(id: number): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(`UPDATE chat_sessions SET last_activity_at = now(), updated_at = now() WHERE id = $1`, [id])
}

/**
 * Records the ACP session id Hermes minted for this thread.
 *
 * Only ever set once, and never overwritten by a later run: the FIRST id is
 * the one whose history Hermes can replay, so a subsequent run's fresh id
 * must not clobber it. `COALESCE` in the UPDATE makes that a property of the
 * statement rather than of the caller remembering.
 */
export async function setHermesSessionId(id: number, hermesSessionId: string): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(
    `UPDATE chat_sessions
        SET hermes_session_id = COALESCE(hermes_session_id, $2), updated_at = now()
      WHERE id = $1`,
    [id, hermesSessionId],
  )
}

export async function updateSession(
  id: number,
  patch: {
    title?: string
    titleSource?: 'auto' | 'user'
    projectId?: number | null
    worktreeId?: number | null
    pinned?: boolean
    archived?: boolean
  },
): Promise<ChatSession | null> {
  const sets: string[] = []
  const params: unknown[] = [id]
  const push = (sql: string, value: unknown) => {
    params.push(value)
    sets.push(`${sql} = $${params.length}`)
  }
  if (patch.title !== undefined) push('title', patch.title)
  if (patch.titleSource !== undefined) push('title_source', patch.titleSource)
  if (patch.projectId !== undefined) push('project_id', patch.projectId)
  if (patch.worktreeId !== undefined) push('worktree_id', patch.worktreeId)
  if (patch.pinned !== undefined) push('pinned', patch.pinned)
  if (patch.archived !== undefined) sets.push(`archived_at = ${patch.archived ? 'now()' : 'NULL'}`)
  if (!sets.length) return getSession(id)

  const pool = getBrokerPool()
  const res = await pool.query<SessionRow>(
    `UPDATE chat_sessions SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
    params,
  )
  return res.rows[0] ? rowToSession(res.rows[0]) : null
}

/**
 * Deletes a session and detaches its runs.
 *
 * Runs are kept, not cascaded: they carry the audit trail, the usage
 * accounting and the worktree they touched. Losing that because someone
 * tidied a chat list would be the wrong trade.
 */
export async function deleteSession(id: number): Promise<void> {
  const pool = getBrokerPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('UPDATE runs SET session_id = NULL WHERE session_id = $1', [id])
    await client.query('DELETE FROM chat_sessions WHERE id = $1', [id])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

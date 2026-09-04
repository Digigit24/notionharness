// Worktree rows — one per checkout this app created for a project resource.
//
// See `migrations/0007_sessions_and_worktrees.sql` for the shape and why it
// hangs off `project_resources` rather than off the project: a project can
// bind several repositories and several plain folders, but `git worktree add`
// only means something inside an initialised repository.
//
// The row is bookkeeping, not the source of truth — git is. `status` is kept
// after a removal instead of deleting the row, so a session that ran in a
// since-deleted worktree can still say where it ran.
import { getBrokerPool } from './db'

export type WorktreeStatus = 'active' | 'archived' | 'removed'

export interface Worktree {
  id: number
  projectId: number
  resourceId: number
  path: string
  branch: string
  baseRef: string
  displayName: string
  status: WorktreeStatus
  createdBySessionId: number | null
  createdBy: number | null
  createdAt: string
  updatedAt: string
  lastActivityAt: string
}

interface WorktreeRow {
  id: string | number
  project_id: string | number
  resource_id: string | number
  path: string
  branch: string
  base_ref: string
  display_name: string
  status: string
  created_by_session_id: string | number | null
  created_by: string | number | null
  created_at: Date
  updated_at: Date
  last_activity_at: Date
}

const COLUMNS = `id, project_id, resource_id, path, branch, base_ref, display_name, status,
                 created_by_session_id, created_by, created_at, updated_at, last_activity_at`

function rowToWorktree(row: WorktreeRow): Worktree {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    resourceId: Number(row.resource_id),
    path: row.path,
    branch: row.branch,
    baseRef: row.base_ref,
    displayName: row.display_name,
    status: (['active', 'archived', 'removed'] as const).includes(row.status as WorktreeStatus)
      ? (row.status as WorktreeStatus)
      : 'active',
    createdBySessionId: row.created_by_session_id === null ? null : Number(row.created_by_session_id),
    createdBy: row.created_by === null ? null : Number(row.created_by),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
  }
}

export async function createWorktreeRow(input: {
  projectId: number
  resourceId: number
  path: string
  branch: string
  baseRef: string
  displayName?: string
  createdBySessionId?: number | null
  createdBy?: number | null
}): Promise<Worktree> {
  const pool = getBrokerPool()
  const res = await pool.query<WorktreeRow>(
    `INSERT INTO worktrees (project_id, resource_id, path, branch, base_ref, display_name, created_by_session_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [
      input.projectId,
      input.resourceId,
      input.path,
      input.branch,
      input.baseRef,
      input.displayName ?? '',
      input.createdBySessionId ?? null,
      input.createdBy ?? null,
    ],
  )
  return rowToWorktree(res.rows[0])
}

export async function getWorktree(id: number): Promise<Worktree | null> {
  const pool = getBrokerPool()
  const res = await pool.query<WorktreeRow>(`SELECT ${COLUMNS} FROM worktrees WHERE id = $1`, [id])
  return res.rows[0] ? rowToWorktree(res.rows[0]) : null
}

export async function listWorktreesForProject(
  projectId: number,
  options: { includeRemoved?: boolean } = {},
): Promise<Worktree[]> {
  const pool = getBrokerPool()
  const res = await pool.query<WorktreeRow>(
    `SELECT ${COLUMNS} FROM worktrees
      WHERE project_id = $1 ${options.includeRemoved ? '' : "AND status <> 'removed'"}
      ORDER BY last_activity_at DESC`,
    [projectId],
  )
  return res.rows.map(rowToWorktree)
}

export async function markWorktreeStatus(id: number, status: WorktreeStatus): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(`UPDATE worktrees SET status = $2, updated_at = now() WHERE id = $1`, [id, status])
}

export async function touchWorktree(id: number): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(
    `UPDATE worktrees SET last_activity_at = now(), updated_at = now() WHERE id = $1`,
    [id],
  )
}

/** Detaches sessions from a worktree row before it is retired, so a session
 * never points at a checkout that no longer exists. */
export async function detachSessionsFromWorktree(id: number): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(`UPDATE chat_sessions SET worktree_id = NULL, updated_at = now() WHERE worktree_id = $1`, [id])
}

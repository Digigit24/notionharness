import type { GrantRole, WorkspaceRole } from '@/lib/permissions/model'

/**
 * The shapes the share surfaces exchange with `./actions.ts`, in a file that
 * imports nothing from a server.
 *
 * `lib/permissions/index.ts` is `server-only`, so a client component that
 * imported it merely to name a role would fail the build. `lib/permissions/
 * model.ts` is deliberately pure — the role names, `weakerGrantRole` and
 * `refusalMessage` all live there — so the panels take their vocabulary from
 * it and everything that needs a database stays behind the actions. This file
 * exists so the two halves share one set of row shapes instead of each
 * declaring its own and drifting.
 */

export type ShareObjectType = 'project' | 'agent' | 'channel'

/** One row of "who has access", as the panel renders it. */
export interface ObjectAccessGrant {
  id: number
  role: GrantRole
  /** An agent is a first-class subject here — see `collections/AccessGrants.ts`
   * for why that is a subject kind rather than a magic user row. */
  subjectKind: 'user' | 'agent'
  subjectId: number
  subjectName: string
  subjectEmail: string | null
  grantedByName: string | null
  createdAt: string | null
}

/**
 * Somebody who could be added but has no grant yet.
 *
 * `impliedRole` is what they can already do WITHOUT any grant, from workspace
 * membership alone. It rides on this row because a grant can only ever RAISE
 * access (`lib/permissions`' absent-row rule), so offering `viewer` to a
 * workspace admin is offering a no-op — and a share dialog that lets somebody
 * do that teaches them the model works in a way it does not.
 */
export interface ShareCandidate {
  userId: number
  name: string
  email: string
  workspaceRole: WorkspaceRole
  impliedRole: GrantRole
}

export interface ObjectAccess {
  objectType: ShareObjectType
  objectId: string
  grants: ObjectAccessGrant[]
  candidates: ShareCandidate[]
  /** Whether the viewer holds the `share` verb here. */
  canShare: boolean
  /** Why not, in the sentence `refusalMessage` wrote for them. Null when they
   * can. Rendered BESIDE the disabled controls rather than replacing them: a
   * control that is silently absent teaches people the feature does not exist. */
  shareRefusal: string | null
  viewerWorkspaceRole: WorkspaceRole | null
}

/** One thing an agent may or may not reach. */
export interface AgentReachRow {
  objectType: 'project' | 'channel'
  objectId: string
  objectName: string
  /** The agent's own grant, or null when it has none on this object. */
  agentRole: GrantRole | null
  /** What the VIEWER has here. The intersection rule needs both sides, and the
   * viewer is the accountable user the panel reasons about. */
  viewerRole: GrantRole | null
  /**
   * The weaker of the two — what the agent would ACTUALLY get running on this
   * person's behalf. Null when either side has none, which must read as a
   * refusal rather than as an empty set of verbs.
   */
  effectiveForViewer: GrantRole | null
  canShare: boolean
  shareRefusal: string | null
  grantId: number | null
}

export interface AgentReach {
  agentId: number
  agentName: string
  rows: AgentReachRow[]
  /**
   * False while this agent is still covered by `lib/permissions`' migration
   * affordance: an agent with NO grants anywhere is treated as `editor` so
   * workspaces that predate the table keep working. The panel says this out
   * loud, because an empty list that silently means "everything" is the worst
   * thing a permissions screen can show.
   */
  hasAnyGrant: boolean
}

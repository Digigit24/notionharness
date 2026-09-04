/**
 * The permission model, as one table rather than as a habit.
 *
 * WHAT THIS REPLACES. Access was checked ad hoc: "is this user the owner, or in
 * `workspace.members`" repeated in every server action that remembered to ask.
 * That is a boolean where a product needs a lattice — it cannot express a
 * read-only guest, cannot say "this agent may read the project but not delete
 * it", and gives no answer at all to "what may this agent do on behalf of this
 * person", which is the question that actually matters once agents can call
 * third-party tools.
 *
 * THE RULE THAT MUST NEVER BEND, stated here because it is the reason the rest
 * of this module has the shape it does:
 *
 *     An agent's effective permissions are the INTERSECTION of its own grants
 *     and the accountable user's. Never the union. Never the agent's alone.
 *
 * Runs are dispatched asynchronously and carry `accountableUser` already, so
 * the information is there; without the intersection, "give the agent Slack"
 * becomes a privilege-escalation path where a viewer triggers a run that posts
 * as an admin. `effectiveAgentRole` below is the only place that rule lives.
 *
 * NO ORGANISATION LAYER. Decided deliberately: the workspace is the top scope,
 * with channels, projects and agents beneath it. Everything in this app is
 * already scoped by workspace — pages, agents, channels, runs, plugins, the
 * spend cap — so adding a layer above it would have meant touching every one of
 * those to gain a grouping nobody had asked to manage yet.
 */

export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

export const GRANT_ROLES = ['viewer', 'editor', 'admin'] as const
export type GrantRole = (typeof GRANT_ROLES)[number]

export const OBJECT_TYPES = ['workspace', 'project', 'agent', 'channel'] as const
export type ObjectType = (typeof OBJECT_TYPES)[number]

/**
 * The verbs, deliberately few.
 *
 * A verb per button is how a permission model becomes unreviewable. These four
 * plus the three administrative ones cover every check in the app, and where a
 * screen needs finer control it is nearly always asking the wrong question —
 * "may they edit this project" rather than "may they rename it".
 */
export const VERBS = [
  'read',
  'write',
  'delete',
  /** Start a run, send a message, call a tool — anything that makes the system
   * act rather than merely change a record. Separated from `write` because a
   * reviewer who may comment on a project must not necessarily be able to spend
   * its budget on agent turns. */
  'execute',
  /** Change who else has access. */
  'share',
  /** Change configuration that costs money or reaches outside: connectors,
   * spend caps, runtime defaults. */
  'administer',
] as const
export type Verb = (typeof VERBS)[number]

/**
 * What each workspace role can do to the workspace itself.
 *
 * Read down the columns: the only thing an `admin` cannot do that an `owner`
 * can is delete or transfer the workspace, and that is enforced separately
 * (see `canDeleteWorkspace`) rather than as a seventh verb nobody would
 * remember to check.
 */
const WORKSPACE_ROLE_VERBS: Record<WorkspaceRole, ReadonlySet<Verb>> = {
  owner: new Set<Verb>(['read', 'write', 'delete', 'execute', 'share', 'administer']),
  admin: new Set<Verb>(['read', 'write', 'delete', 'execute', 'share', 'administer']),
  member: new Set<Verb>(['read', 'write', 'execute']),
  viewer: new Set<Verb>(['read']),
}

/** What a per-object grant adds on top of workspace membership. */
const GRANT_ROLE_VERBS: Record<GrantRole, ReadonlySet<Verb>> = {
  viewer: new Set<Verb>(['read']),
  editor: new Set<Verb>(['read', 'write', 'execute']),
  admin: new Set<Verb>(['read', 'write', 'delete', 'execute', 'share']),
}

export function workspaceRoleAllows(role: WorkspaceRole, verb: Verb): boolean {
  return WORKSPACE_ROLE_VERBS[role].has(verb)
}

export function grantRoleAllows(role: GrantRole, verb: Verb): boolean {
  return GRANT_ROLE_VERBS[role].has(verb)
}

/** Ordered weakest to strongest, so two sources of access can be combined by
 * taking the stronger — and, for the agent rule, the weaker. */
const WORKSPACE_RANK: Record<WorkspaceRole, number> = { viewer: 1, member: 2, admin: 3, owner: 4 }
const GRANT_RANK: Record<GrantRole, number> = { viewer: 1, editor: 2, admin: 3 }

export function strongerWorkspaceRole(a: WorkspaceRole, b: WorkspaceRole): WorkspaceRole {
  return WORKSPACE_RANK[a] >= WORKSPACE_RANK[b] ? a : b
}

export function weakerGrantRole(a: GrantRole, b: GrantRole): GrantRole {
  return GRANT_RANK[a] <= GRANT_RANK[b] ? a : b
}

/**
 * A workspace role expressed as a per-object grant role, so the two scales can
 * be compared at all.
 *
 * `member` maps to `editor` rather than to `admin`: being in a workspace lets
 * you work in it, not re-share everything in it. That is the line between the
 * two scales and it is the only interesting thing this function does.
 */
export function grantRoleFromWorkspaceRole(role: WorkspaceRole): GrantRole {
  switch (role) {
    case 'owner':
    case 'admin':
      return 'admin'
    case 'member':
      return 'editor'
    case 'viewer':
      return 'viewer'
  }
}

/**
 * THE INTERSECTION RULE, in one function.
 *
 * An agent acting for a person gets the weaker of what the agent may do and
 * what that person may do. Both are required: an agent with no grant of its own
 * gets nothing even if the person is an owner (an agent must be given its
 * access deliberately), and an agent granted `admin` acting for a `viewer` gets
 * `viewer`.
 *
 * Returns null when either side has no access at all, which is the common case
 * and must read as a refusal rather than as an empty set of verbs.
 */
export function effectiveAgentRole(
  agentRole: GrantRole | null,
  accountableUserRole: GrantRole | null,
): GrantRole | null {
  if (!agentRole || !accountableUserRole) return null
  return weakerGrantRole(agentRole, accountableUserRole)
}

/** Only the owner may delete or transfer a workspace. Stated as a function
 * rather than a verb so the check cannot be satisfied by `administer`. */
export function canDeleteWorkspace(role: WorkspaceRole | null): boolean {
  return role === 'owner'
}

/**
 * A sentence for a refusal, written for the person who hit it.
 *
 * "Forbidden" tells somebody nothing about what to do next. Naming the role
 * they have and the role the action needs turns a dead end into a message they
 * can forward to whoever can fix it.
 */
export function refusalMessage(input: {
  verb: Verb
  objectType: ObjectType
  currentRole: WorkspaceRole | GrantRole | null
}): string {
  const what =
    input.verb === 'read'
      ? 'open'
      : input.verb === 'administer'
        ? 'change the settings of'
        : input.verb === 'share'
          ? 'change who can see'
          : input.verb === 'execute'
            ? 'run anything in'
            : input.verb
  if (!input.currentRole) {
    return `You do not have access to this ${input.objectType}.`
  }
  return `You are a ${input.currentRole} here, which cannot ${what} this ${input.objectType}.`
}

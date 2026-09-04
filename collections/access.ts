import type { Access, Where } from 'payload'

/**
 * Phase 0 — one access policy for Payload's own API, written once.
 *
 * WHAT THE AUDIT GOT WRONG, AND WHAT IS ACTUALLY TRUE. The enterprise handoff
 * says a collection with no `access` block is "fully open" and readable by an
 * unauthenticated internet request. Measured against this install's own
 * Payload 3.88.0, that is not so: `node_modules/payload/dist/auth/
 * defaultAccess.js` is `({ req: { user } }) => Boolean(user)`, and an
 * unauthenticated `GET /api/plugins` against a live dev server answers 403
 * "You are not allowed to perform this action."
 *
 * The hole is one layer in, and it is real. Any authenticated Payload user —
 * including one belonging to ZERO workspaces — could read and write EVERY
 * collection in EVERY workspace, because `Boolean(user)` asks whether somebody
 * is signed in and never asks whose data they are touching. Demonstrated
 * live before this file existed: a throwaway `member` in no workspace read
 * `plugins` rows for workspaces 1 and 6 (headers included), the whole
 * `activity` audit log, pages across every workspace, and successfully
 * POSTed a new page into workspace 1.
 *
 * WHY THIS COSTS THE APP NOTHING. Every Payload Local API call in `app/`,
 * `lib/`, `components/` and `scripts/` passes `overrideAccess: true` — checked
 * by walking each `payload.find|findByID|create|update|delete|count(` call and
 * its balanced argument list; the only two hits without it were a doc comment
 * and a JSDoc block, not calls. So these blocks govern exactly one surface:
 * Payload's public REST/GraphQL API and its own `/admin` panel. Nothing the
 * product does routes through them.
 *
 * THE SHAPE. Workspace membership is read from `workspace-members`, which is
 * the same table `lib/permissions` reads, so there is one answer to "is this
 * person in this workspace" rather than two that can drift. It is deliberately
 * NOT `lib/permissions`'s `loadAccess`: that module is `server-only` and would
 * drag the whole permission layer into `payload.config.ts`'s import graph,
 * which the admin panel and the migration runner both load.
 *
 * REJECTED ALTERNATIVE: `admin-only, deny everyone else`, which is one line
 * and unbreakable. Rejected because the admin panel is the operator's tool for
 * exactly the moments when the app itself is broken, and a policy that makes a
 * workspace owner unable to look at their own rows there is one that gets
 * turned off wholesale the first time it is inconvenient.
 */

interface AccessUser {
  id: number
  role?: string | null
}

/** Payload's `req.user` is the Users doc, which carries the app-level
 * `role: 'admin' | 'member'` field — distinct from a workspace role. An app
 * admin is the operator of this install and sees everything. */
export const isAppAdmin = (user: AccessUser | null | undefined): boolean => user?.role === 'admin'

/** The workspace roles that may change things that cost money or reach
 * outside — the same line `lib/permissions`'s `administer` verb draws, restated
 * here because that module is `server-only` and this one is not. */
const ADMINISTERING_ROLES = ['owner', 'admin'] as const

/**
 * The ids of every workspace this person belongs to, optionally only those
 * where they hold one of `roles`.
 *
 * One query, and it is allowed to be one query: this runs only on Payload's
 * own API/admin surface, never on a page the product renders (see the header).
 * `overrideAccess: true` is required and not a shortcut — without it, reading
 * `workspace-members` to decide access would recurse into that collection's
 * own access check.
 */
async function myWorkspaceIds(
  req: {
    user?: AccessUser | null
    payload: {
      find: (args: Record<string, unknown>) => Promise<{ docs: Array<Record<string, unknown>> }>
    }
  },
  roles?: readonly string[],
): Promise<number[]> {
  const user = req.user
  if (!user) return []
  const members = await req.payload.find({
    collection: 'workspace-members',
    where: roles
      ? { and: [{ user: { equals: user.id } }, { role: { in: [...roles] } }] }
      : { user: { equals: user.id } },
    limit: 500,
    depth: 0,
    overrideAccess: true,
  })
  const ids = new Set<number>()
  for (const doc of members.docs) {
    const workspace = doc.workspace
    const id = typeof workspace === 'object' && workspace !== null ? (workspace as { id?: unknown }).id : workspace
    if (typeof id === 'number') ids.add(id)
  }
  return [...ids]
}

/**
 * Scoped to the workspaces this person is in, via `path` — which is `workspace`
 * for a collection that names one directly and something like
 * `project.workspace` for a collection one hop away.
 *
 * Returning `false` rather than `{ workspace: { in: [] } }` for somebody in no
 * workspace at all is not a micro-optimisation: an empty `in` list is a query
 * some database layers treat as "no constraint", and a permission that depends
 * on how an adapter compiles an empty array is not a permission.
 */
export function inMyWorkspaces(path = 'workspace'): Access {
  return async ({ req }) => {
    const user = req.user as AccessUser | null | undefined
    if (!user) return false
    if (isAppAdmin(user)) return true
    const ids = await myWorkspaceIds(req as never)
    if (ids.length === 0) return false
    return { [path]: { in: ids } } as Where
  }
}

/** The same, narrowed to workspaces where this person is an owner or admin.
 * For rows that configure spend, runtimes or outbound tools — a `member` may
 * work in a workspace without being able to rewire what it can reach. */
export function inMyAdministeredWorkspaces(path = 'workspace'): Access {
  return async ({ req }) => {
    const user = req.user as AccessUser | null | undefined
    if (!user) return false
    if (isAppAdmin(user)) return true
    const ids = await myWorkspaceIds(req as never, ADMINISTERING_ROLES)
    if (ids.length === 0) return false
    return { [path]: { in: ids } } as Where
  }
}

/** Rows that belong to one person — their notifications, their push
 * subscriptions, their preferences. Nobody else's business, an app admin
 * included for `read` only where the collection is explicitly operational. */
export function ownedByMe(path = 'user'): Access {
  return ({ req }) => {
    const user = req.user as AccessUser | null | undefined
    if (!user) return false
    return { [path]: { equals: user.id } } as Where
  }
}

/** The operator, and nobody else. For rows that carry no workspace and no
 * owner — the audit log's `entityType`/`entityId` pair cannot be joined to a
 * workspace, and inventing a join here would be a guess with a security
 * consequence. */
export const appAdminOnly: Access = ({ req }) => isAppAdmin(req.user as AccessUser | null | undefined)

/** Signed in, full stop. Used only where the rows are non-sensitive install-
 * level configuration that every member legitimately reads. */
export const signedIn: Access = ({ req }) => Boolean(req.user)

/** Nobody, over the public API. The app reaches these rows through
 * `overrideAccess: true` and no human has a reason to hand-edit them. */
export const noOne: Access = () => false

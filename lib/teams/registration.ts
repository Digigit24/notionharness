// R6.2 — making `/api/mcp/teams` reachable by a dispatched agent.
//
// The endpoint and its seven tools already existed; nothing could call them.
// A dispatched agent only ever receives the MCP servers `lib/plugins/
// resolve.ts` builds from `plugins` rows, and no row pointed at the team
// endpoint, so Teams was a board only a human could drive. This module writes
// that row.
//
// It is one row per WORKSPACE, not per team and not per slot, and that is the
// whole reason the `{{TEAM_SLOT_ID}}` substitution exists: the endpoint needs
// to know which slot is speaking, but the slot is a property of the run, not
// of the configuration. A per-slot row would mean a row per member per team,
// each carrying a hard-coded slot id that becomes a key to somebody else's
// lane the moment the roster is edited — the same objection that keeps a live
// run token out of the row (see `lib/plugins/resolve.ts`).
import { getPayloadClient } from '@/lib/payload'

/** The path the team MCP server is served at. Also the identity of the row:
 * a plugin in this workspace whose URL ends here IS the team plugin, whatever
 * somebody later renamed it to. */
const TEAM_MCP_PATH = '/api/mcp/teams'

/**
 * The externally reachable origin for this install.
 *
 * Read from the environment, never derived from the incoming request: the
 * agent that will call this URL may be running on a different machine from
 * the browser (or the cron tick) that triggered the registration. This is the
 * same variable `settings/plugins/page.tsx` shows the human, so what they see
 * offered and what a run actually gets cannot disagree.
 */
function appOrigin(): string {
  return (process.env.NOTIONFORGE_URL || 'http://localhost:3000').replace(/\/$/, '')
}

export type TeamPluginRegistration =
  | { status: 'created'; id: number; url: string }
  /** Already present. Deliberately NOT repaired — see `ensureTeamMcpPlugin`. */
  | { status: 'existing'; id: number; url: string; enabled: boolean }

/**
 * Ensures this workspace has a plugin row for the team MCP server.
 *
 * Idempotent and workspace-scoped: it looks only at rows whose `workspace` is
 * this workspace, so a team in one workspace can never observe, reuse or
 * disturb another's registration.
 *
 * **It does not repair an existing row, on purpose.** Once the row exists it
 * belongs to the human: they may have disabled it, narrowed its scope to a
 * few agents, or added a header of their own, and re-asserting our defaults on
 * every team creation would silently undo all three. The one case that costs
 * us is a moved `NOTIONFORGE_URL`, where the stored URL then points at the old
 * origin; the caller is handed the URL it found so it can say so, and the
 * plugins settings screen is where a human fixes it.
 *
 * Two callers, and no others. `createTeam` in `lib/broker/teams.ts` is the
 * one that matters: making a team is what makes the tools it needs. The
 * dispatcher (`lib/dispatcher/worker.ts`) calls it as well, but ONLY for a run
 * that turns out to occupy a slot — teams built before any of this existed
 * never went through `createTeam`'s new path, and would otherwise stay
 * permanently toolless with no way for a user to tell.
 *
 * Not called from a page render: a GET must not write configuration, and the
 * row would then appear in workspaces that have never had a team. Not called
 * unconditionally from the dispatcher either, which would be a lookup on the
 * hot path of every run in the install to re-learn a fact that is nearly
 * always already true.
 */
export async function ensureTeamMcpPlugin(workspaceId: number): Promise<TeamPluginRegistration> {
  const payload = await getPayloadClient()
  const url = `${appOrigin()}${TEAM_MCP_PATH}`

  // Filtered in JS rather than with a `like` on `url`, because the match has
  // to be "path ends with /api/mcp/teams" regardless of origin — a row written
  // when the install answered on localhost must still be recognised after it
  // moves — and that is not a prefix a SQL LIKE expresses without also
  // matching `.../api/mcp/teams-of-someone-else`. A workspace has a handful of
  // plugins, so this is one indexed query either way.
  const { docs } = await payload.find({
    collection: 'plugins',
    where: { workspace: { equals: workspaceId } },
    depth: 0,
    limit: 200,
    overrideAccess: true,
  })
  const existing = docs.find((plugin) => {
    const value = typeof plugin.url === 'string' ? plugin.url : ''
    return value.replace(/\/$/, '').endsWith(TEAM_MCP_PATH)
  })
  if (existing) {
    return { status: 'existing', id: existing.id, url: existing.url ?? url, enabled: existing.enabled !== false }
  }

  const created = await payload.create({
    collection: 'plugins',
    data: {
      workspace: workspaceId,
      name: 'Team',
      description:
        'Talk to your teammates and work the team board: send and read messages, list, claim and finish tasks. ' +
        'Only ever active for a run that occupies a team slot.',
      transport: 'http',
      url,
      // The three headers `app/api/mcp/teams/route.ts` authenticates on, in
      // the order it reads them. Every value is a placeholder: nothing live is
      // stored, and `lib/plugins/resolve.ts` fills all three in at resolve
      // time from the run it is resolving for. `{{TEAM_SLOT_ID}}` is also what
      // scopes this row — a run with no slot never receives this server at
      // all, rather than receiving it and failing every call.
      headers: [
        { name: 'Authorization', value: 'Bearer {{RUN_TOKEN}}' },
        { name: 'X-Run-Id', value: '{{RUN_ID}}' },
        { name: 'X-Team-Slot-Id', value: '{{TEAM_SLOT_ID}}' },
      ],
      enabled: true,
      // Workspace scope is safe here precisely BECAUSE of the slot gate above.
      // The alternative — scope 'agents', listing every agent that fills a
      // slot — would need re-running on every roster edit (add a slot, swap an
      // agent, create a second team) from server actions this unit does not
      // own, and every path that was missed would be a member silently without
      // tools. Naming every agent and letting the run decide is both simpler
      // and strictly narrower at execution time.
      scope: 'workspace',
      agents: [],
      args: [],
      env: [],
      configOptions: [],
    },
    overrideAccess: true,
  })
  return { status: 'created', id: created.id, url }
}

// ---------------------------------------------------------------------------
// `teams.workspace_mode` — what is wired, and what honestly is not.
//
// WIRED: the dispatcher now resolves a team run's checkout through
// `getTeamBindingForSession` (`lib/broker/teams.ts`), which reads the mode and
// answers with one checkout for the whole team under 'shared' and the slot's
// own under 'per_member'. That is the run-time meaning of the column, and it
// is real: two slots of a 'shared' team dispatch into the same directory and
// see each other's edits; two slots of a 'per_member' team cannot.
//
// NOT WIRED: nothing CREATES those worktrees when a team is made. That is not
// an omission, it is a missing input. `git worktree add` needs a repository,
// and `addWorktree`/`createWorktreeRow` need a `project_resources` row to hang
// the checkout off (see `lib/broker/worktrees.ts`'s header: a worktree belongs
// to a resource, because a project can bind several repos and several plain
// folders). A team has none of that — `teams` carries `workspace_id`, `name`,
// `description`, `workspace_mode`, `created_by`, and no project. Inventing one
// here would mean guessing which of the workspace's projects, and which of its
// repositories, a team is about; a team created for something with no repo at
// all would get a checkout of an unrelated codebase.
//
// Closing it needs, in order: a `team_id`-shaped project binding (a migration
// under `lib/broker/migrations/`, plus a project picker in the create-team
// dialog and its server action, none of which this unit owns), and then a
// call from team creation that cuts one worktree for 'shared' or one per slot
// for 'per_member' and writes `team_members.worktree_id`. Until then the mode
// is honoured for teams whose slots a human has bound to worktrees in Work —
// which does work today — and is inert for teams whose slots nobody bound.

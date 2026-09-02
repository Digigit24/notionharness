// B0: Frame — shared shapes for the ⌘K command bar.
//
// B0 built `'navigate'` and `'act'` only, with `'navigate'` backed by
// per-category `like` queries. B-3 "Surface" (B1.3) filled that seam in
// with real Postgres full-text search over pages/tasks/projects/agents/
// comments/run transcripts (`lib/search.ts`, wired through `searchCommandBar`
// in `.../command-bar/actions.ts`) plus a filter-triggered Hermes skills
// query — see `NAVIGATE_PROVIDERS` below and `lib/search.ts`'s top-of-file
// comment for the full picture. The "ask → agent run" natural-language
// path (B1.2 / B3) is still out of scope here — see the SEAM comment below
// and in `command-bar.tsx` for exactly where it slots in later.

/**
 * SEAM (B1.2): the palette's top-level mode. `'ask'` is not implemented in
 * this pass — no natural-language-to-agent-run path exists yet — but the
 * type already carries the slot so wiring it in later is an additive
 * change to this union plus one new render branch in `command-bar.tsx`,
 * not a rewrite of the mode/routing state machine.
 */
export type CommandBarMode = 'navigate' | 'act' /* | 'ask' — B1.2, not yet implemented */

/**
 * One navigate-mode result category, in list order. `command-bar.tsx` maps
 * each `key` to a small builder function (results → rendered rows) — this
 * array is the seam B1.3 hooks into: the *category list itself* (order,
 * labels, empty states) lives here, independent from how each category's
 * `searchCommandBar` results get produced (see that function's own SEAM
 * comment in `.../command-bar/actions.ts`, and `lib/search.ts`'s own
 * top-of-file comment, for the search-implementation half of this seam).
 *
 * `projects` was excluded here at B-0 time ("no detail route exists yet")
 * — that reason is now stale: `roadmap/b1-project-detail` (merged the same
 * day) shipped `projects/[projectId]/page.tsx`, confirmed live via
 * `lib/entity-links.server.ts`'s `hrefForEntity('project', ...)`. B-3
 * re-adds it rather than leaving a category out for a reason that no
 * longer holds.
 *
 * `comments` navigates to its parent task (`tasks?task=<id>`) — comments
 * have no page of their own, same as runs landing on their review page
 * rather than a nonexistent per-comment route.
 *
 * `skills` is real (Hermes's own skills API, not Postgres) but
 * deliberately query-on-filter, not query-on-every-keystroke — see
 * `lib/search.ts`'s `searchSkills` comment for why. `command-bar.tsx`'s
 * default (no filter chip active) view skips this category for that
 * reason; it only queries once the user filters to it explicitly.
 */
export interface NavigateProviderKey {
  key: 'pages' | 'tasks' | 'projects' | 'agents' | 'comments' | 'runs' | 'skills'
  label: string
  emptyLabel: string
}

export const NAVIGATE_PROVIDERS: NavigateProviderKey[] = [
  { key: 'pages', label: 'Pages', emptyLabel: 'No matching pages' },
  { key: 'tasks', label: 'Tasks', emptyLabel: 'No matching tasks' },
  { key: 'projects', label: 'Projects', emptyLabel: 'No matching projects' },
  { key: 'agents', label: 'Agents', emptyLabel: 'No matching agents' },
  { key: 'comments', label: 'Comments', emptyLabel: 'No matching comments' },
  { key: 'runs', label: 'Runs', emptyLabel: 'No matching runs' },
  { key: 'skills', label: 'Skills', emptyLabel: 'No matching skills' },
]

/**
 * One act-mode command. `keywords` back the lightweight prefix-matching in
 * `command-bar.tsx` (typing "assign" surfaces the Assign command even
 * without opening the Actions list first) — this is intentionally not a
 * fuzzy-match engine, just `label`/`keywords` substring containment.
 */
export interface ActCommand {
  key: 'create-task' | 'assign' | 'start-run' | 'change-status'
  label: string
  description: string
  keywords: string[]
}

export const ACT_COMMANDS: ActCommand[] = [
  {
    key: 'create-task',
    label: 'Create task',
    description: 'Add a new task to this workspace',
    keywords: ['create', 'new', 'task', 'add'],
  },
  {
    key: 'assign',
    label: 'Assign',
    description: "Change a task's assignee",
    keywords: ['assign', 'assignee', 'owner'],
  },
  {
    key: 'start-run',
    label: 'Start run',
    description: 'Assign an agent to a task and start a run',
    keywords: ['run', 'start', 'agent', 'dispatch'],
  },
  {
    key: 'change-status',
    label: 'Change status',
    description: "Move a task to a different status",
    keywords: ['status', 'move', 'change'],
  },
]

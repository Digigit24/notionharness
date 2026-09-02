// B0: Frame — shared shapes for the ⌘K command bar.
//
// This batch builds `'navigate'` and `'act'` only. Full-text search (B1.3,
// Postgres full-text over pages/tasks/projects/agents/skills/run
// transcripts/comments) and the "ask → agent run" natural-language path
// (B1.2 / B3) are explicitly out of scope here — see the SEAM comments
// below and in `command-bar.tsx` for exactly where each slots in later.

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
 * comment in `.../command-bar/actions.ts` for the search-implementation
 * half of this seam).
 *
 * Projects are deliberately not a navigate-mode category: `lib/entity-
 * links.server.ts`'s own `hrefForEntity` comment says it plainly —
 * "project (and other future entityTypes) -> null until a detail route
 * exists" — there is no per-project page anywhere in this app yet, only a
 * picker used from inside the create-task act-mode flow. Inventing a fake
 * destination for a "Projects" navigate category would violate the "don't
 * fake it" rule for this pass more than skipping the category does.
 */
export interface NavigateProviderKey {
  key: 'pages' | 'tasks' | 'agents' | 'runs'
  label: string
  emptyLabel: string
}

export const NAVIGATE_PROVIDERS: NavigateProviderKey[] = [
  { key: 'pages', label: 'Pages', emptyLabel: 'No matching pages' },
  { key: 'tasks', label: 'Tasks', emptyLabel: 'No matching tasks' },
  { key: 'agents', label: 'Agents', emptyLabel: 'No matching agents' },
  { key: 'runs', label: 'Runs', emptyLabel: 'No matching runs' },
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

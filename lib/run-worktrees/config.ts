import { homedir } from 'node:os'
import { join } from 'node:path'

// ROADMAP P6.4 — nothing in this codebase defines "the repo runs are
// worktree-isolated against" yet (RunWorktreeManager itself is only ever
// smoke-tested against a disposable temp repo, never wired to a real
// dispatcher). In THIS product, agents work against this very codebase
// (the whole roadmap dogfoods itself — Pillar 2.7), so `process.cwd()` (this
// running server's own repo root) is the deliberate, correct default, not
// an accidental one — same reasoning as this project's other "verified
// machine state" defaults (e.g. `scripts/hermes-acp-smoke.ts`'s hardcoded
// binary path). Still fully overridable, and every path is resolved
// (`resolve()`-equivalent happens inside `run-worktrees/manager.ts` itself).
export function resolveRunWorktreeConfig() {
  return {
    /** The real, live repository a run's branch eventually merges back into. */
    source: process.env.RUN_WORKTREE_SOURCE_REPO || process.cwd(),
    /** Where bare clones + disposable per-run/per-merge worktrees live. */
    rootDir: process.env.RUN_WORKTREE_ROOT || join(homedir(), '.notionforge', 'run-worktrees'),
    /** The branch in `source` an approved run's branch merges into. */
    baseBranch: process.env.RUN_WORKTREE_BASE_BRANCH || 'main',
  }
}

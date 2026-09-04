// ROADMAP P6.4 — "approve-and-merge... fast-forward or real merge, keep it
// simple." The merge itself never touches `source`'s own live checked-out
// working tree directly — this repo (`source`) is the same one a human (or
// another agent) may be actively working in at the moment a review is
// approved, and running `git merge` straight against someone's live
// checkout risks clobbering uncommitted work or moving the branch out from
// under them.
//
// Instead: fetch `source`'s current base branch into the bare clone (a read
// cache, not authoritative), perform the actual merge in a disposable
// *integration* worktree created off the bare clone (a real merge needs a
// working tree to materialize file contents / detect conflicts — a bare
// repo alone can only trivially fast-forward a ref), then `git push` the
// merged result back to `source`. That final push is the only step that
// touches `source` at all, and git's own default (`receive.denyCurrentBranch
// = refuse`) safely REJECTS a push that would move a currently checked-out
// branch — so the worst-case failure mode here is a clean, surfaced error
// ("couldn't push — sync manually"), never a corrupted working tree.
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { RunWorktree } from './manager'
import { bestEffort } from '@/lib/failures'
import { git, gitBare } from '@/lib/git/repo'

export interface MergeRunBranchOptions {
  /** The live repository the merge is ultimately delivered to. */
  sourceRepo: string
  /** The branch in `sourceRepo` this run's branch merges into. */
  baseBranch: string
  /** Root directory to create the disposable integration worktree under. */
  rootDir: string
}

export interface MergeRunBranchResult {
  merged: boolean
  /** True if the merge fast-forwarded (no new merge commit). */
  fastForward: boolean
  /** The resulting commit on `baseBranch` after merging, if successful. */
  mergeCommit: string | null
  /** Populated when `merged` is false — a conflict, a rejected push, etc. */
  error: string | null
}

export async function mergeRunBranch(worktree: RunWorktree, opts: MergeRunBranchOptions): Promise<MergeRunBranchResult> {
  const { barePath, branch } = worktree
  const { sourceRepo, baseBranch, rootDir } = opts

  // 1. Bring the bare clone's copy of baseBranch up to date with whatever
  // `sourceRepo` actually has right now — the bare clone was only ever
  // fetched from `origin` (see manager.ts's ensureBareClone), which may not
  // be `sourceRepo` itself in every configuration, so fetch directly from it.
  try {
    await gitBare(barePath, ['fetch', sourceRepo, `${baseBranch}:refs/heads/${baseBranch}`, '--force'])
  } catch (err) {
    return { merged: false, fastForward: false, mergeCommit: null, error: `Could not fetch ${baseBranch} from source: ${message(err)}` }
  }

  // 2. Perform the actual merge in a disposable integration worktree off the
  // bare clone — never in the run's own worktree (that's the run's own
  // branch, not baseBranch) and never in sourceRepo's live checkout.
  const integrationPath = join(rootDir, 'merges', `${worktree.runId}-${randomUUID().slice(0, 8)}`)
  await mkdir(join(rootDir, 'merges'), { recursive: true })
  await gitBare(barePath, ['worktree', 'add', integrationPath, baseBranch])

  try {
    let fastForward = true
    try {
      await git(integrationPath, ['merge', '--ff-only', branch])
    } catch {
      fastForward = false
      try {
        await git(integrationPath, ['merge', '--no-edit', branch])
      } catch (mergeErr) {
        await bestEffort(
          git(integrationPath, ['merge', '--abort']),
          'the conflict below is what the caller is told about; a failed abort in a throwaway worktree must not replace it',
          { branch },
        )
        return {
          merged: false,
          fastForward: false,
          mergeCommit: null,
          error: `Merge conflict — resolve manually. ${message(mergeErr)}`,
        }
      }
    }

    const mergeCommit = (await git(integrationPath, ['rev-parse', 'HEAD'])).trim()

    // 3. Deliver the merge to sourceRepo.
    //
    // First try a plain push — works whenever sourceRepo is bare, or has
    // `receive.denyCurrentBranch=updateInstead` configured for exactly this
    // scenario. Git's *default* (`refuse`) rejects a push that would move
    // the currently checked-out branch, though, which is the common case
    // for this product's own dogfood deployment (a normal working-tree repo
    // with `main` checked out) — so on rejection, fall back to a
    // fast-forward-only local merge run *inside sourceRepo itself*
    // (`git fetch` + `git merge --ff-only`, exactly what `git pull --ff-only`
    // does). That fallback is safe by the same git guarantee either way: a
    // `--ff-only` merge refuses cleanly rather than overwriting anything if
    // sourceRepo's working tree has conflicting uncommitted changes at that
    // exact moment.
    try {
      await gitBare(barePath, ['push', sourceRepo, `${baseBranch}:${baseBranch}`])
    } catch {
      try {
        await git(sourceRepo, ['fetch', barePath, baseBranch])
        await git(sourceRepo, ['merge', '--ff-only', 'FETCH_HEAD'])
      } catch (err) {
        return {
          merged: false,
          fastForward,
          mergeCommit,
          error: `Merged in an isolated worktree but could not deliver it to source (push rejected and a fast-forward-only sync also failed — sourceRepo likely has uncommitted changes on ${baseBranch}; resolve manually): ${message(err)}`,
        }
      }
    }

    return { merged: true, fastForward, mergeCommit, error: null }
  } finally {
    await bestEffort(
      gitBare(barePath, ['worktree', 'remove', integrationPath, '--force']),
      'the merge result is already decided; a leftover integration worktree is reclaimed later rather than reported now',
      { integrationPath },
    )
    await bestEffort(
      rm(integrationPath, { recursive: true, force: true }),
      'the same, one step further: the directory outliving the run costs disk, not correctness',
      { integrationPath },
    )
  }
}

function message(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = (err as { stderr?: unknown }).stderr
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
  }
  return err instanceof Error ? err.message : String(err)
}

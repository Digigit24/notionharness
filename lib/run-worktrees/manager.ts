/**
 * Shared bare clone + isolated per-run worktrees.
 *
 * R12-P5.1 — every git invocation here goes through `lib/git/repo.ts`'s
 * hardened `git()`/`gitBare()` (explicit cwd, a timeout, `windowsHide`,
 * captured stderr, a capped buffer, typed failures) rather than a fourth
 * bespoke `execFile` wrapper.
 *
 * R12-P5.2 — the lifecycle survives a crash on any step: `ensureBareClone`
 * retries a failed `fetch` against a clone that already exists rather than
 * failing the whole run over a network blip, `remove()` refuses to discard
 * uncommitted work without saying so, and `reapOrphanedWorktrees` (run once
 * on boot — see `app/api/dispatcher/tick/route.ts`) removes `agent/run/*`
 * branches left behind by a worker that died between creating one and the
 * run ever settling.
 *
 * R12-P5.3 — the mutex is real across processes, not just in-process. This
 * file used to say "the mutex is in-process by design", which was true only
 * while exactly one Node process ever touched a given bare clone — false the
 * moment a dev server and a dispatcher loop (or two dispatcher workers) share
 * one machine, which this project does today. `withLock` below still
 * serialises same-process callers with no I/O (see its own comment for why
 * that layer stays), but the actual cross-process exclusion is
 * `./lock.ts`'s Postgres advisory lock.
 */
import { access, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { git, gitBare } from '@/lib/git/repo'
import { isAppFailure, raise } from '@/lib/failures'
import { logger } from '@/lib/logger'
import { withRepoLock } from './lock'

const RUN_ID_RE = /^[A-Za-z0-9_-]+$/

/** Long enough for a clone of a real project over a slow link; short enough
 * that a hung git can never hang the caller forever. Separate from
 * `lib/git/repo.ts`'s 30s default because a clone/fetch is legitimately
 * slower than every other git command this app runs. */
const CLONE_TIMEOUT_MS = 5 * 60_000

/** How many times a failed `fetch` against an ALREADY-EXISTING local bare
 * clone is retried before giving up on it. A clone that exists locally has
 * everything it needs to serve a worktree at its last-known state, so a
 * network blip on the refresh is worth one retry rather than failing the
 * whole run over — the initial `clone --bare` (no local copy to fall back
 * to) is not retried here; its failure is the real, first-attempt story. */
const FETCH_RETRIES = 2
const FETCH_RETRY_DELAY_MS = 1_000

export interface RunWorktree {
  runId: string
  barePath: string
  worktreePath: string
  branch: string
  ref: string
}

export interface RunWorktreeManagerOptions {
  rootDir: string
}

export interface RemoveWorktreeOptions {
  /** Remove local changes before deleting the worktree. Defaults to false. */
  discardChanges?: boolean
  /** Keep the worktree on disk for later archival/recovery. */
  preserveChanges?: boolean
}

// Pure, side-effect-free naming scheme, extracted so a caller that only
// needs to *locate* a run's worktree (e.g. the P6.4 review surface — a run
// might be settled and its worktree already removed by the time it's
// reviewed) doesn't have to re-derive this in a second place. `create()`
// below is the only thing that calls `git`; everything about *where* things
// live is computed here.
export function barePathFor(rootDir: string, source: string): string {
  const name = source.replace(/[\\/:]+/g, '_').replace(/[^A-Za-z0-9_.-]/g, '_')
  return resolve(rootDir, `${name}.git`)
}

/** The branch naming scheme every run-worktree lives under — the one place
 * that knows it, so the orphan reaper (below) and `create()` cannot drift
 * apart on what an "agent run branch" looks like. */
export function runBranchFor(runId: string): string {
  return `agent/run/${runId}`
}

const RUN_BRANCH_RE = /^agent\/run\/(.+)$/

export function describeRunWorktree(rootDir: string, source: string, runId: string, ref = 'HEAD'): RunWorktree {
  if (!RUN_ID_RE.test(runId)) throw new Error(`Invalid run id: ${runId}`)
  return {
    runId,
    barePath: barePathFor(rootDir, source),
    worktreePath: resolve(rootDir, 'runs', runId),
    branch: runBranchFor(runId),
    ref,
  }
}

// P5.3 — two layers, cheapest first. `locks` serialises calls made by THIS
// process with no I/O at all, so two run-creations racing inside one
// dispatcher never both reach for a database connection just to find out
// they need to wait anyway — only one `pg_advisory_lock` connection is ever
// held per process at a time, not one per concurrent local caller.
// `withRepoLock` (./lock.ts) is what makes the mutex true ACROSS processes.
const locks = new Map<string, Promise<void>>()

async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolveRelease => { release = resolveRelease })
  const queued = prior.then(() => current)
  locks.set(key, queued)
  await prior
  try {
    return await withRepoLock(key, operation)
  } finally {
    release()
    if (locks.get(key) === queued) locks.delete(key)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export class RunWorktreeManager {
  constructor(private readonly options: RunWorktreeManagerOptions) {}

  /**
   * Clones the bare mirror if it does not exist yet, or refreshes it.
   *
   * A missing clone is not retried — there is no local fallback, and a
   * `source` that cannot be reached at all is the real, first-attempt story
   * a caller needs to see. An EXISTING clone's `fetch` is the transient half
   * P5.2 asks for: retried a bounded number of times, and if every retry
   * still fails, the clone is returned anyway at its last-known state rather
   * than failing the run over a refresh — a worktree cut from a slightly
   * stale mirror is still a working checkout; a run that never got one is not.
   */
  async ensureBareClone(source: string): Promise<string> {
    const barePath = barePathFor(this.options.rootDir, source)
    return withLock(barePath, async () => {
      await mkdir(this.options.rootDir, { recursive: true })
      let exists = true
      try {
        await access(join(barePath, 'HEAD'))
      } catch {
        exists = false
      }

      if (!exists) {
        await git(this.options.rootDir, ['clone', '--bare', source, barePath], CLONE_TIMEOUT_MS)
        return barePath
      }

      let lastErr: unknown
      for (let attempt = 1; attempt <= FETCH_RETRIES + 1; attempt += 1) {
        try {
          await gitBare(barePath, ['fetch', '--prune', 'origin'], { timeoutMs: CLONE_TIMEOUT_MS })
          return barePath
        } catch (err) {
          lastErr = err
          if (attempt <= FETCH_RETRIES) {
            logger.warn('worktree fetch failed, retrying', {
              barePath,
              attempt,
              error: err instanceof Error ? err.message : String(err),
            })
            await sleep(FETCH_RETRY_DELAY_MS * attempt)
          }
        }
      }
      // Every retry failed. The local clone already has everything it had
      // before this call, which is a real, usable (if stale) checkout — so
      // this is logged and swallowed rather than raised, which is the
      // "retry the transient half rather than fail the whole run" P5.2 asks
      // for. Named with real content, not "cleaning up" (P5.6): which repo,
      // how many attempts, and git's own reason.
      logger.warn('worktree fetch exhausted its retries — serving the existing local clone as-is', {
        barePath,
        attempts: FETCH_RETRIES + 1,
        error: lastErr instanceof Error ? lastErr.message : String(lastErr),
      })
      return barePath
    })
  }

  async create(source: string, runId: string, ref = 'HEAD'): Promise<RunWorktree> {
    const descriptor = describeRunWorktree(this.options.rootDir, source, runId, ref)
    const barePath = await this.ensureBareClone(source)
    return withLock(barePath, async () => {
      await mkdir(join(this.options.rootDir, 'runs'), { recursive: true })
      // P5.6 — this wipes whatever a PRIOR, never-settled attempt at this
      // same run left behind (lease recovery re-creating after a crash). If
      // that leftover checkout still holds uncommitted work, name it before
      // it goes — a re-create silently eating an agent's half-written diff
      // is exactly the kind of quiet loss this pillar exists to prevent.
      const leftoverStatus = await git(descriptor.worktreePath, ['status', '--porcelain']).catch(() => null)
      if (leftoverStatus && leftoverStatus.trim()) {
        const files = leftoverStatus.trim().split('\n').filter(Boolean)
        logger.warn('discarding a leftover, never-settled worktree before recreating it', {
          runId,
          worktreePath: descriptor.worktreePath,
          fileCount: files.length,
          files: files.slice(0, 20),
        })
      }
      await rm(descriptor.worktreePath, { recursive: true, force: true })
      // A worker can die after creating the worktree but before settling the
      // run. Prune its missing registration and remove the run-scoped branch
      // so lease recovery can recreate the isolated checkout cleanly.
      await gitBare(barePath, ['worktree', 'prune'])
      const existingBranch = await gitBare(barePath, ['branch', '--list', descriptor.branch])
      if (existingBranch.trim()) await gitBare(barePath, ['branch', '--delete', '--force', descriptor.branch])
      await gitBare(barePath, ['worktree', 'add', '-b', descriptor.branch, descriptor.worktreePath, ref], {
        timeoutMs: CLONE_TIMEOUT_MS,
      })
      return descriptor
    })
  }

  /**
   * Removes a run's disposable worktree.
   *
   * P5.2/P5.6 — a worktree holding uncommitted work is never silently force-
   * removed. Neither flag set and the worktree is dirty: this raises
   * `worktree_dirty` naming what would be lost, BEFORE anything is deleted,
   * rather than letting git's bare `--force`-shaped refusal (or a silent
   * force) speak for it. `discardChanges: true` is the caller saying "I have
   * already decided this is disposable" (e.g. `retention.ts`, after the
   * run's own review is closed) — that path still logs what it is about to
   * discard, with real content, rather than deleting quietly.
   */
  async remove(worktree: RunWorktree, options: RemoveWorktreeOptions = {}): Promise<void> {
    return withLock(worktree.barePath, async () => {
      if (options.preserveChanges) return

      let dirty = false
      let statusText = ''
      try {
        statusText = (await git(worktree.worktreePath, ['status', '--porcelain'])).trim()
        dirty = statusText.length > 0
      } catch {
        // The worktree directory may already be gone (a prior partial
        // removal) — nothing to check, nothing to discard.
        dirty = false
      }

      if (dirty && !options.discardChanges) {
        const files = statusText.split('\n').filter(Boolean)
        raise(
          'worktree_dirty',
          `This worktree has ${files.length} uncommitted change${files.length === 1 ? '' : 's'}. Remove it with force to discard ${files.length === 1 ? 'it' : 'them'}.`,
          { detail: files.slice(0, 20).join('\n') },
        )
      }

      if (dirty && options.discardChanges) {
        const files = statusText.split('\n').filter(Boolean)
        logger.warn('discarding uncommitted changes before removing a run worktree', {
          runId: worktree.runId,
          worktreePath: worktree.worktreePath,
          fileCount: files.length,
          files: files.slice(0, 20),
        })
        await git(worktree.worktreePath, ['reset', '--hard', 'HEAD']).catch(() => {})
        await git(worktree.worktreePath, ['clean', '-fd']).catch(() => {})
      }

      // `--force` only once discarding has already been decided (above) or
      // never needed (the tree was clean). A tree that turned dirty in the
      // race between the status check and here — someone typed into it
      // while this ran — must still refuse rather than have `--force` paper
      // over it, so that failure is deliberately NOT part of the catch below.
      const forceRemove = dirty && Boolean(options.discardChanges)
      await gitBare(worktree.barePath, [
        'worktree',
        'remove',
        ...(forceRemove ? ['--force'] : []),
        worktree.worktreePath,
      ]).catch((err) => {
        if (isAppFailure(err) && err.code === 'worktree_dirty') throw err
        // Anything else here (already gone, not a working tree) means the
        // directory is already not git's problem; `worktree prune` below
        // cleans up the registration either way.
        logger.warn('worktree remove reported a problem — pruning stale registration instead', {
          runId: worktree.runId,
          worktreePath: worktree.worktreePath,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      await gitBare(worktree.barePath, ['worktree', 'prune'])
    })
  }
}

// ---------------------------------------------------------------------------
// Orphan reaper — P5.2, run once on boot.
//
// A worker can die between `create()` making a worktree and the run
// settling. `worktree prune` cleans up git's own bookkeeping for a worktree
// directory that is already gone, but it does nothing about a run-scoped
// branch (`agent/run/<id>`) left behind in the bare clone with no `runs` row
// to justify it. That is this function's job.

export interface OrphanReapReport {
  barePath: string
  prunedWorktrees: boolean
  /** Worktree directories force-removed because their branch was orphaned —
   * a worker died before the run ever settled, so this is real uncommitted
   * work with no owner left to ask. Named separately from `removedBranches`
   * because it is the more consequential of the two (P5.6). */
  removedWorktrees: string[]
  /** Run-scoped branches removed because no `runs` row justifies them. */
  removedBranches: string[]
  failures: Array<{ branch: string; error: string }>
}

/** One entry of `git worktree list --porcelain`, just enough to match a
 * worktree back to the branch it has checked out. */
async function listWorktreeBranches(barePath: string): Promise<Map<string, string>> {
  const out = await gitBare(barePath, ['worktree', 'list', '--porcelain']).catch(() => '')
  const byBranch = new Map<string, string>()
  let currentPath: string | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ') && currentPath) {
      byBranch.set(line.slice('branch '.length).trim().replace(/^refs\/heads\//, ''), currentPath)
      currentPath = null
    } else if (line === '') {
      currentPath = null
    }
  }
  return byBranch
}

/**
 * Reaps orphaned run branches (and, if still present, their worktree
 * directories) from one bare clone.
 *
 * `liveRunIds` is supplied by the caller (a query against `runs`) rather
 * than queried in here, so this stays testable against a synthetic set of
 * "still real" ids with no database required — the chaos script (P5.4)
 * exercises exactly that.
 *
 * A crashed worker's orphan is not just an unreferenced branch — the
 * worktree directory `create()` checked it out into is usually still there
 * too (nothing ever removed it, because the run never settled), and git
 * refuses to delete a branch that is checked out anywhere. So a worktree
 * still pointing at an orphaned branch is force-removed FIRST — verified
 * live: without this step the branch deletion below fails with git's own
 * "cannot delete branch … used by worktree at …" and the orphan survives
 * forever. This is the one place in this function that discards real,
 * uncommitted work, which is exactly why P5.6 requires it be logged with
 * real content rather than folded silently into "pruned".
 */
export async function reapOrphanedWorktrees(barePath: string, liveRunIds: ReadonlySet<string>): Promise<OrphanReapReport> {
  const report: OrphanReapReport = {
    barePath,
    prunedWorktrees: false,
    removedWorktrees: [],
    removedBranches: [],
    failures: [],
  }

  try {
    await access(join(barePath, 'HEAD'))
  } catch {
    // No bare clone here yet — nothing to reap.
    return report
  }

  // P5.3 — the same cross-process lock `create()`/`remove()` take, so the
  // reaper (run once on boot, possibly by more than one process at once if a
  // dev server and a dispatcher loop both start around the same time) cannot
  // interleave with an in-flight `create()` on the same bare clone.
  await withRepoLock(barePath, async () => {
    const worktreeByBranch = await listWorktreeBranches(barePath)

    await gitBare(barePath, ['worktree', 'prune']).then(
      () => {
        report.prunedWorktrees = true
      },
      (err) => {
        report.failures.push({ branch: '(prune)', error: err instanceof Error ? err.message : String(err) })
      },
    )

    const out = await gitBare(barePath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/agent/run']).catch(
      () => '',
    )
    const branches = out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    for (const branch of branches) {
      const match = RUN_BRANCH_RE.exec(branch)
      if (!match) continue
      const runId = match[1]
      if (liveRunIds.has(runId)) continue

      const worktreePath = worktreeByBranch.get(branch)
      if (worktreePath) {
        logger.warn('reaping an orphaned run worktree — no matching run row, force-removing whatever it held', {
          barePath,
          branch,
          worktreePath,
        })
        try {
          await gitBare(barePath, ['worktree', 'remove', '--force', worktreePath])
          report.removedWorktrees.push(worktreePath)
        } catch (err) {
          report.failures.push({ branch, error: err instanceof Error ? err.message : String(err) })
          continue
        }
      }

      try {
        await gitBare(barePath, ['branch', '--delete', '--force', branch])
        report.removedBranches.push(branch)
      } catch (err) {
        report.failures.push({ branch, error: err instanceof Error ? err.message : String(err) })
      }
    }
  })

  // Named with real content (which branches, how many), not "cleaning up" —
  // P5.6 applies to an automated path exactly as much as to a button.
  if (report.removedBranches.length > 0 || report.failures.length > 0) {
    logger.info('reaped orphaned run-worktree branches', {
      barePath,
      removedWorktrees: report.removedWorktrees,
      removedBranches: report.removedBranches,
      failures: report.failures,
    })
  }

  return report
}

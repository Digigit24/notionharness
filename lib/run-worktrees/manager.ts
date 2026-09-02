/** Shared bare clone + isolated per-run worktrees. The mutex is in-process by design. */
import { execFile } from 'node:child_process'
import { access, mkdir, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'

const exec = promisify(execFile)
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/

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

export function describeRunWorktree(rootDir: string, source: string, runId: string, ref = 'HEAD'): RunWorktree {
  if (!RUN_ID_RE.test(runId)) throw new Error(`Invalid run id: ${runId}`)
  return {
    runId,
    barePath: barePathFor(rootDir, source),
    worktreePath: resolve(rootDir, 'runs', runId),
    branch: `agent/run/${runId}`,
    ref,
  }
}

const locks = new Map<string, Promise<void>>()

async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolveRelease => { release = resolveRelease })
  const queued = prior.then(() => current)
  locks.set(key, queued)
  await prior
  try { return await operation() } finally {
    release()
    if (locks.get(key) === queued) locks.delete(key)
  }
}

async function git(barePath: string, args: string[]) {
  return exec('git', ['--git-dir', barePath, ...args], { windowsHide: true })
}

export class RunWorktreeManager {
  constructor(private readonly options: RunWorktreeManagerOptions) {}

  async ensureBareClone(source: string): Promise<string> {
    const barePath = barePathFor(this.options.rootDir, source)
    return withLock(barePath, async () => {
      await mkdir(this.options.rootDir, { recursive: true })
      try {
        await access(join(barePath, 'HEAD'))
        await git(barePath, ['fetch', '--prune', 'origin'])
      } catch {
        await exec('git', ['clone', '--bare', source, barePath], { windowsHide: true })
      }
      return barePath
    })
  }

  async create(source: string, runId: string, ref = 'HEAD'): Promise<RunWorktree> {
    const descriptor = describeRunWorktree(this.options.rootDir, source, runId, ref)
    const barePath = await this.ensureBareClone(source)
    return withLock(barePath, async () => {
      await mkdir(join(this.options.rootDir, 'runs'), { recursive: true })
      await rm(descriptor.worktreePath, { recursive: true, force: true })
      // A worker can die after creating the worktree but before settling the
      // run. Prune its missing registration and remove the run-scoped branch
      // so lease recovery can recreate the isolated checkout cleanly.
      await git(barePath, ['worktree', 'prune'])
      const existingBranch = await git(barePath, ['branch', '--list', descriptor.branch])
      if (existingBranch.stdout.trim()) await git(barePath, ['branch', '--delete', '--force', descriptor.branch])
      await git(barePath, ['worktree', 'add', '-b', descriptor.branch, descriptor.worktreePath, ref])
      return descriptor
    })
  }

  async remove(worktree: RunWorktree, options: RemoveWorktreeOptions = {}): Promise<void> {
    return withLock(worktree.barePath, async () => {
      if (options.preserveChanges) return
      if (options.discardChanges) await exec('git', ['-C', worktree.worktreePath, 'reset', '--hard', 'HEAD'], { windowsHide: true })
      await git(worktree.barePath, ['worktree', 'remove', worktree.worktreePath])
      await git(worktree.barePath, ['worktree', 'prune'])
    })
  }
}

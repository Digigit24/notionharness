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

  private barePath(source: string): string {
    const name = source.replace(/[\\/:]+/g, '_').replace(/[^A-Za-z0-9_.-]/g, '_')
    return resolve(this.options.rootDir, `${name}.git`)
  }

  async ensureBareClone(source: string): Promise<string> {
    const barePath = this.barePath(source)
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
    if (!RUN_ID_RE.test(runId)) throw new Error(`Invalid run id: ${runId}`)
    const barePath = await this.ensureBareClone(source)
    return withLock(barePath, async () => {
      const worktreePath = resolve(this.options.rootDir, 'runs', runId)
      const branch = `agent/run/${runId}`
      await mkdir(join(this.options.rootDir, 'runs'), { recursive: true })
      await rm(worktreePath, { recursive: true, force: true })
      await git(barePath, ['worktree', 'add', '-b', branch, worktreePath, ref])
      return { runId, barePath, worktreePath, branch, ref }
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

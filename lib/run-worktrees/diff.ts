// ROADMAP P6.4 — review-surface read side: "a run's diff is just `git diff`
// against the base branch in that worktree." Operates on the BARE clone
// (`worktree.barePath`) via `--git-dir`, not the OS-level worktree directory
// — the branch and its commits live in the bare clone's shared object store
// the moment they're made (a `git worktree add`-created branch is a ref in
// the same repository, not a separate one), so this works even after the
// run's own worktree directory has been cleaned up (`RunWorktreeManager
// .remove()`), which is the common case by the time a run is actually
// reviewed.
//
// Three-dot diff (`base...branch`) throughout, not two-dot: this is "what
// did the run's branch introduce since it forked from base," robust even if
// base has moved on independently in the meantime — a two-dot diff would
// also show base's own unrelated later changes as if the run had undone
// them.
import { access, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RunWorktree } from './manager'

const exec = promisify(execFile)

async function gitBare(barePath: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['--git-dir', barePath, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unknown'

export interface ChangedFile {
  path: string
  oldPath: string | null
  status: FileChangeStatus
}

function parseStatusLetter(letter: string): FileChangeStatus {
  switch (letter[0]) {
    case 'A':
      return 'added'
    case 'M':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'unknown'
  }
}

export async function getChangedFiles(worktree: RunWorktree): Promise<ChangedFile[]> {
  const stdout = await gitBare(worktree.barePath, ['diff', '--name-status', `${worktree.ref}...${worktree.branch}`])
  const files: ChangedFile[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const status = parseStatusLetter(parts[0])
    if (status === 'renamed' || status === 'copied') {
      files.push({ path: parts[2], oldPath: parts[1], status })
    } else {
      files.push({ path: parts[1], oldPath: null, status })
    }
  }
  return files
}

export async function getFileDiff(worktree: RunWorktree, file: ChangedFile): Promise<string> {
  const pathspecs = file.oldPath && file.oldPath !== file.path ? [file.oldPath, file.path] : [file.path]
  return gitBare(worktree.barePath, ['diff', `${worktree.ref}...${worktree.branch}`, '--', ...pathspecs])
}

export interface WorktreeState {
  /** false if the branch itself doesn't exist yet — e.g. no run has been dispatched for real. */
  branchExists: boolean
  headCommit: string | null
  headSubject: string | null
  /** Commits on `branch` not on `ref` (this run's own work). */
  aheadCount: number
  /** Commits on `ref` not on `branch` (how far behind base this run started from). */
  behindCount: number
  /** Whether the OS-level worktree directory still exists (it's disposable — may already be cleaned up). */
  worktreeExists: boolean
  /** Uncommitted changes in the worktree directory, if it still exists. Always false if worktreeExists is false. */
  hasUncommittedChanges: boolean
}

export async function getWorktreeState(worktree: RunWorktree): Promise<WorktreeState> {
  let headCommit: string | null = null
  let headSubject: string | null = null
  let aheadCount = 0
  let behindCount = 0
  let branchExists = true

  try {
    headCommit = (await gitBare(worktree.barePath, ['rev-parse', worktree.branch])).trim()
    headSubject = (await gitBare(worktree.barePath, ['log', '-1', '--format=%s', worktree.branch])).trim()
    const counts = (
      await gitBare(worktree.barePath, ['rev-list', '--left-right', '--count', `${worktree.ref}...${worktree.branch}`])
    ).trim()
    const [behind, ahead] = counts.split(/\s+/).map((n) => Number(n) || 0)
    behindCount = behind
    aheadCount = ahead
  } catch {
    // Branch doesn't exist in the bare clone yet — no run has actually been
    // dispatched through RunWorktreeManager for this run id. Surfaced via
    // `branchExists: false`, not thrown, so the review page can show a clear
    // "nothing to review yet" state instead of an error page.
    branchExists = false
  }

  let worktreeExists = false
  let hasUncommittedChanges = false
  try {
    await access(worktree.worktreePath)
    worktreeExists = (await stat(worktree.worktreePath)).isDirectory()
  } catch {
    worktreeExists = false
  }
  if (worktreeExists) {
    try {
      const status = await exec('git', ['-C', worktree.worktreePath, 'status', '--porcelain'], { windowsHide: true })
      hasUncommittedChanges = status.stdout.trim().length > 0
    } catch {
      hasUncommittedChanges = false
    }
  }

  return { branchExists, headCommit, headSubject, aheadCount, behindCount, worktreeExists, hasUncommittedChanges }
}

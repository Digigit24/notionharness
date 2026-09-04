// Git operations against a real checkout on this machine.
//
// Shelling out to the user's own `git`, rather than adding a JS git library,
// for the same reason Orca does (github.com/stablyai/orca — the most
// battle-tested version of this idea available to read): worktrees, hooks,
// credential helpers, submodules and every local config the user already has
// only behave correctly through the real binary. A library reimplementation
// diverges precisely where it matters.
//
// Nothing here interpolates user input into a shell — `execFile` takes an
// argv array, so a branch name containing a space or a semicolon is an
// argument, never a command.
import { execFile } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Long enough for a cold `git status` on a large tree, short enough that a
 * hung git never becomes a hung page. */
const GIT_TIMEOUT_MS = 30_000

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export async function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      // Never let a credential helper or editor open a prompt: a blocked git
      // inside a server request is indistinguishable from a hang.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    })
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    throw new GitError(
      (e.stderr || e.message || 'git failed').trim().split('\n')[0],
      args,
      (e.stderr ?? '').trim(),
    )
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ['rev-parse', '--is-inside-work-tree'], 10_000)
    return out.trim() === 'true'
  } catch {
    return false
  }
}

export async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The branch a new worktree should be cut from.
 *
 * Probe order copied from Orca's `repo-default-base-ref.ts`, which encodes
 * something worth keeping: `origin/HEAD` is the repository's own declared
 * default and is right even when the branch is called something unusual;
 * only when it is missing (a clone made with `--single-branch`, or a repo
 * with no remote at all) do the conventional names get tried.
 */
export async function resolveBaseRef(repoDir: string): Promise<string> {
  const candidates = ['refs/remotes/origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']
  for (const candidate of candidates) {
    try {
      const out = await git(repoDir, ['rev-parse', '--abbrev-ref', candidate], 10_000)
      const name = out.trim()
      if (name && name !== 'HEAD') return name.replace(/^origin\/HEAD$/, 'origin/main')
    } catch {
      // Try the next one.
    }
  }
  // A repository with commits but none of the usual names still has a current
  // branch, and cutting from it beats refusing to work.
  try {
    const current = (await git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'], 10_000)).trim()
    if (current && current !== 'HEAD') return current
  } catch {
    // Fall through.
  }
  return 'HEAD'
}

export interface GitFileChange {
  path: string
  /** Porcelain v2 status letters, e.g. `M.`, `.M`, `A.`, `??`. */
  code: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  renamedFrom?: string
}

export interface GitStatus {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  changes: GitFileChange[]
  clean: boolean
}

/**
 * Working-tree status, from `--porcelain=v2 --branch`.
 *
 * v2 rather than v1 because it reports ahead/behind and rename sources as
 * structured fields instead of requiring the caller to parse a human string
 * that changes with locale.
 */
export async function readStatus(dir: string): Promise<GitStatus> {
  const out = await git(dir, ['status', '--porcelain=v2', '--branch', '--untracked-files=all'])
  const status: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, changes: [], clean: true }

  for (const line of out.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim()
      status.branch = value === '(detached)' ? null : value
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line)
      if (match) {
        status.ahead = Number(match[1])
        status.behind = Number(match[2])
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
      // `2 ...` adds a rename score and a tab-separated original path.
      const parts = line.split(' ')
      const code = parts[1] ?? '..'
      const rest = parts.slice(8).join(' ')
      const [path, renamedFrom] = line.startsWith('2 ') ? rest.split('\t') : [rest, undefined]
      status.changes.push({
        path,
        code,
        staged: code[0] !== '.',
        unstaged: code[1] !== '.',
        untracked: false,
        ...(renamedFrom ? { renamedFrom } : {}),
      })
    } else if (line.startsWith('? ')) {
      status.changes.push({
        path: line.slice(2),
        code: '??',
        staged: false,
        unstaged: true,
        untracked: true,
      })
    }
  }
  status.clean = status.changes.length === 0
  return status
}

export interface GitCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  date: string
}

/** Recent commits, newest first. Uses unit separators so a subject
 * containing any punctuation cannot break the parse. */
export async function readCommits(dir: string, limit = 30, range?: string): Promise<GitCommit[]> {
  const args = ['log', `-${Math.max(1, Math.min(200, limit))}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI']
  if (range) args.push(range)
  const out = await git(dir, args)
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, subject, author, date] = line.split('\x1f')
      return { hash, shortHash, subject, author, date }
    })
}

export interface GitBranch {
  name: string
  current: boolean
  upstream: string | null
}

export async function readBranches(dir: string): Promise<GitBranch[]> {
  const out = await git(dir, [
    'for-each-ref',
    '--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)',
    'refs/heads',
  ])
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, head, upstream] = line.split('\x1f')
      return { name, current: head === '*', upstream: upstream || null }
    })
}

/** Unified diff for the whole tree, or one path. Capped so a huge diff
 * cannot blow past the response size — the UI renders a notice instead. */
export async function readDiff(
  dir: string,
  options: { path?: string; staged?: boolean; base?: string; maxBytes?: number } = {},
): Promise<{ patch: string; truncated: boolean }> {
  const args = ['diff', '--no-color']
  if (options.staged) args.push('--staged')
  if (options.base) args.push(`${options.base}...HEAD`)
  if (options.path) args.push('--', options.path)
  const patch = await git(dir, args)
  const max = options.maxBytes ?? 400_000
  return patch.length > max
    ? { patch: patch.slice(0, max), truncated: true }
    : { patch, truncated: false }
}

// ---------------------------------------------------------------------------
// Worktrees

export interface WorktreeCreateResult {
  path: string
  branch: string
  baseRef: string
}

/** Hermes-safe branch/directory name from arbitrary text. */
export function slugifyBranch(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'work'
}

/**
 * Creates a worktree, borrowing Orca's exact recipe.
 *
 * `--no-track` then recording the base in `branch.<name>.base` is the part
 * worth copying: it keeps the new branch from adopting the base's upstream
 * (so a later `git push` cannot target the wrong remote branch) while still
 * writing down what it was cut from, in git's own config, where it survives
 * this app forgetting.
 */
export async function addWorktree(
  repoDir: string,
  options: { path: string; branch: string; baseRef?: string; fetch?: boolean },
): Promise<WorktreeCreateResult> {
  const baseRef = options.baseRef ?? (await resolveBaseRef(repoDir))
  if (options.fetch) {
    // Best-effort: an offline machine should still get a worktree.
    await git(repoDir, ['fetch', '--prune', 'origin'], 60_000).catch(() => '')
  }
  // A previous run may have left the bookkeeping behind even though the
  // directory is gone; pruning first turns a confusing "already exists" into
  // a clean create.
  await git(repoDir, ['worktree', 'prune']).catch(() => '')
  await git(repoDir, ['worktree', 'add', '--no-track', '-b', options.branch, options.path, baseRef], 120_000)
  await git(repoDir, ['config', '--local', `branch.${options.branch}.base`, baseRef]).catch(() => '')
  return { path: options.path, branch: options.branch, baseRef }
}

export async function removeWorktree(
  repoDir: string,
  options: { path: string; branch?: string; force?: boolean; deleteBranch?: boolean },
): Promise<void> {
  const args = ['worktree', 'remove']
  if (options.force) args.push('--force')
  args.push(options.path)
  await git(repoDir, args, 60_000)
  if (options.deleteBranch && options.branch) {
    await git(repoDir, ['branch', options.force ? '-D' : '-d', options.branch]).catch(() => '')
  }
  await git(repoDir, ['worktree', 'prune']).catch(() => '')
}

export interface ListedWorktree {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  detached: boolean
}

/** Every worktree git itself knows about — including ones this app did not
 * create, which is how a manually-added checkout becomes visible instead of
 * silently missing. */
export async function listWorktrees(repoDir: string): Promise<ListedWorktree[]> {
  const out = await git(repoDir, ['worktree', 'list', '--porcelain'])
  const entries: ListedWorktree[] = []
  let current: Partial<ListedWorktree> | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current?.path) entries.push({ bare: false, detached: false, head: null, branch: null, ...current } as ListedWorktree)
      current = { path: line.slice('worktree '.length).trim() }
    } else if (!current) {
      continue
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim()
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace('refs/heads/', '')
    } else if (line === 'bare') {
      current.bare = true
    } else if (line === 'detached') {
      current.detached = true
    }
  }
  if (current?.path) entries.push({ bare: false, detached: false, head: null, branch: null, ...current } as ListedWorktree)
  return entries
}

// ---------------------------------------------------------------------------
// Staging and committing

export async function stagePaths(dir: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await git(dir, ['add', '--', ...paths])
}

export async function unstagePaths(dir: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await git(dir, ['restore', '--staged', '--', ...paths])
}

export async function commit(dir: string, message: string): Promise<GitCommit | null> {
  if (!message.trim()) throw new Error('A commit needs a message.')
  await git(dir, ['commit', '-m', message], 60_000)
  const [head] = await readCommits(dir, 1)
  return head ?? null
}

// ---------------------------------------------------------------------------
// GitHub, via the user's own `gh` CLI

export interface GhStatus {
  installed: boolean
  authenticated: boolean
  account: string | null
  detail: string
}

/**
 * Whether GitHub is usable on this machine, asked the way Orca asks it.
 *
 * Deliberately no OAuth app and no token storage of our own: `gh` already
 * owns a credential in the OS keyring, `git` already knows how to use it, and
 * adding a second copy of a GitHub token to this app would be a new secret to
 * leak for no capability gained.
 */
export async function readGhStatus(): Promise<GhStatus> {
  try {
    const { stdout, stderr } = await exec('gh', ['auth', 'status'], {
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const text = `${stdout}${stderr}`
    const account = /Logged in to [^\s]+ account ([^\s]+)/.exec(text)?.[1] ?? null
    return {
      installed: true,
      authenticated: /Logged in to/.test(text),
      account,
      detail: text.trim().split('\n').slice(0, 3).join(' ').slice(0, 300),
    }
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message?: string }
    const text = `${e.stderr ?? ''}${e.message ?? ''}`
    if (e.code === 'ENOENT' || /is not recognized|not found/i.test(text)) {
      return {
        installed: false,
        authenticated: false,
        account: null,
        detail: 'The GitHub CLI (gh) is not installed on this machine.',
      }
    }
    return {
      installed: true,
      authenticated: false,
      account: null,
      // `gh auth status` exits non-zero precisely when nobody is logged in,
      // so this is the normal "not connected yet" path, not a failure.
      detail: text.trim().split('\n').slice(0, 3).join(' ').slice(0, 300) || 'Not signed in to GitHub.',
    }
  }
}

/**
 * Runs one `gh` command in a repository and returns its stdout.
 *
 * The same reasoning as `readGhStatus`: `gh` owns the credential, so this app
 * never holds a GitHub token. Arguments are passed as an array to `execFile`,
 * never interpolated into a shell string — a branch name is user-controlled
 * and a shell here would be a command-injection seam.
 */
export async function runGh(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await exec('gh', args, {
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
    // Never let a credential prompt block a server-side call forever.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout
}

/** Clones with `gh` so the user's existing GitHub credential is used, with no
 * token ever passing through this app. */
export async function ghClone(repo: string, targetDir: string): Promise<void> {
  await exec('gh', ['repo', 'clone', repo, targetDir], {
    timeout: 10 * 60_000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

export async function pathIsInside(parent: string, child: string): Promise<boolean> {
  const normalise = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalise(child).startsWith(`${normalise(parent)}/`)
}

export async function ensureAccessible(dir: string): Promise<void> {
  try {
    await access(join(dir, '.'))
  } catch {
    throw new Error(`This machine cannot read ${dir}.`)
  }
}

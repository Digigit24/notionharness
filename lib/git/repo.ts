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
import { AppFailure, raise, type FailureCode } from '@/lib/failures'

const exec = promisify(execFile)

/** Long enough for a cold `git status` on a large tree, short enough that a
 * hung git never becomes a hung page. */
const GIT_TIMEOUT_MS = 30_000

/** git's stderr, capped before it becomes a failure's `detail`. It travels to
 * a browser and onto a screen, and a bad `fetch` can produce a great deal of
 * it; the first few thousand characters carry the diagnosis. */
const MAX_DETAIL_CHARS = 4_000

/**
 * A git command that failed.
 *
 * Extends `AppFailure` rather than `Error` so the classification and git's
 * own stderr survive the trip out of a server action — `guard()` turns this
 * into an envelope whose `detail` is already the stderr. That is the whole
 * reason the repository browser can now say "git is not installed" rather
 * than repeating whichever sentence happened to arrive. `args` and `stderr`
 * stay as fields because the callers that already read them (hunk staging
 * matches on git's apply output) are still right to.
 */
export class GitError extends AppFailure {
  readonly args: string[]
  readonly stderr: string

  constructor(info: { code: FailureCode; message: string; detail?: string; retryable?: boolean }, args: string[], stderr: string) {
    super({
      code: info.code,
      message: info.message,
      detail: info.detail,
      retryable: info.retryable ?? false,
    })
    this.name = 'GitError'
    this.args = args
    this.stderr = stderr
  }
}

/** What Node hands back when a spawned process fails. Written out because
 * every field below is load-bearing for the classification. */
interface ExecFailure {
  code?: string | number
  killed?: boolean
  signal?: string | null
  stderr?: string
  message?: string
}

/**
 * Which of git's failures this is.
 *
 * A missing binary, a moved repository and a deleted ref are three different
 * problems with three different fixes, and until this existed the UI printed
 * whichever string arrived. The patterns are git's own words in English —
 * git localises its messages, so a machine with a translated git falls
 * through to `unknown` and still shows the stderr, which is the honest
 * outcome rather than a confidently wrong code.
 */
async function classifyGitFailure(cwd: string, args: string[], err: ExecFailure): Promise<GitError> {
  const stderr = String(err.stderr ?? '').trim()
  const detail = (stderr || String(err.message ?? '').trim()).slice(0, MAX_DETAIL_CHARS) || undefined
  const text = `${stderr}\n${err.message ?? ''}`.toLowerCase()
  const build = (code: FailureCode, message: string, retryable = false) =>
    new GitError({ code, message, detail, retryable }, args, stderr)

  if (err.code === 'ENOENT') {
    // `spawn git ENOENT` means one of two entirely different things: no git
    // on PATH, or no such working directory. One stat on the error path is
    // the cheapest way to tell them apart, and telling them apart is the
    // difference between "install git" and "that clone has moved".
    if (!(await directoryExists(cwd))) {
      return build('worktree_missing', 'That working copy is no longer on this machine.', true)
    }
    return build('git_missing', 'git is not installed on this machine, or is not on this server’s PATH.')
  }
  if (err.killed || err.code === 'ETIMEDOUT') {
    return build('timeout', 'git took too long and was stopped.', true)
  }
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxbuffer length exceeded/.test(text)) {
    return build('repo_too_large', 'git produced more output than this can read at once.')
  }
  if (/not a git repository/.test(text)) {
    return build('not_a_repository', 'That directory is not a git repository.')
  }
  if (/is not a working tree|worktree .* does not exist/.test(text)) {
    return build('worktree_missing', 'That working copy is no longer on this machine.', true)
  }
  // git's own refusal to discard work — `worktree remove` on a checkout with
  // modified or untracked files says exactly this rather than silently
  // deleting anything. The sentence itself never mentions the word
  // "worktree", so this is keyed on the command (`args`) actually run, not
  // just the text — `.includes` rather than a positional check because a
  // bare-repo caller prepends `--git-dir <path>` before the subcommand.
  // Named explicitly (P5.6) rather than left as `unknown`, so a caller can
  // branch on the code instead of pattern-matching the sentence a second time.
  if (args.includes('worktree') && args.includes('remove') && /contains modified or untracked files/.test(text)) {
    return build('worktree_dirty', 'This worktree has uncommitted changes. Remove it with force to discard them.')
  }
  // git echoes the rev it could not resolve, and a rev containing a colon
  // (`<commit>:lib/git/nope`) names a path inside a tree rather than a
  // revision — so this is a missing path, not a missing branch.
  if (/not a tree object|does not exist in|exists on disk, but not in|not a valid object name \S*:/.test(text)) {
    return build('not_found', 'That path does not exist at this revision.')
  }
  // `Needed a single revision` is what `rev-parse --verify` says for anything
  // it could not resolve, and it is by far the most common of these — it is
  // the exact wording git uses for a branch that has been deleted. Verified
  // against git 2.x on this machine rather than assumed.
  if (/needed a single revision|unknown revision|bad revision|not a valid object name|ambiguous argument|invalid object name/.test(text)) {
    return build('bad_ref', 'That branch, tag or commit does not exist in this repository.')
  }
  // Nothing recognised: git's own first line is still the best sentence
  // available, and it is a real sentence rather than an invented code.
  return build('unknown', stderr.split('\n')[0] || String(err.message ?? '').split('\n')[0] || 'git failed.')
}

/** Never let a credential helper or editor open a prompt: a blocked git
 * inside a server request is indistinguishable from a hang. Exported so the
 * few callers that cannot go through `git()`/`gitBare()` directly — `tree.ts`
 * reads a blob as a raw buffer, `checks.ts` shells out to `gh` — still run
 * with the same guards instead of a second, slightly different environment. */
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
}

/**
 * P5.1 — the one hardened path every `execFile('git', …)` in this codebase
 * routes through. Explicit `cwd`, a timeout, `windowsHide` (this runs on
 * Windows too), a capped `maxBuffer`, and every failure classified rather
 * than thrown raw. `git()` and `gitBare()` below are both thin callers of
 * this; nothing else in `lib/git/*` or `lib/run-worktrees/*` should call
 * `execFile('git', …)` directly.
 */
async function execGit(cwd: string, args: string[], timeoutMs: number, maxBuffer = 16 * 1024 * 1024): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer,
      env: GIT_ENV,
    })
    return stdout
  } catch (err) {
    throw await classifyGitFailure(cwd, args, err as ExecFailure)
  }
}

export async function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return execGit(cwd, args, timeoutMs)
}

/**
 * The same hardened path, for git commands that address a repository by
 * `--git-dir` rather than by `cwd` — `RunWorktreeManager`'s shared bare
 * clone, and the review surface (`lib/run-worktrees/diff.ts`,
 * `lib/run-worktrees/merge.ts`) that reads a run's branch out of it after its
 * disposable worktree has already been removed.
 *
 * `cwd` still matters even though the repository is addressed by
 * `--git-dir`: it is what Node spawns the process in, and it is what
 * `classifyGitFailure`'s ENOENT-vs-missing-directory check stats. It
 * defaults to `barePath` itself, which exists for every caller except the
 * one moment it does not — mid-clone, before the bare directory has been
 * created — so that one caller passes its own known-good `cwd` (its `rootDir`,
 * already `mkdir`'d) explicitly rather than getting a misleading
 * "directory not found" for a repository that was never expected to exist yet.
 */
export async function gitBare(
  barePath: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {},
): Promise<string> {
  return execGit(
    options.cwd ?? barePath,
    ['--git-dir', barePath, ...args],
    options.timeoutMs ?? GIT_TIMEOUT_MS,
    options.maxBuffer,
  )
}

/** The same classification for a git process spawned elsewhere in `lib/git`
 * — `tree.ts` reads blobs as raw buffers and cannot go through `git()`, but
 * its failures are the same failures and must arrive with the same codes. */
export async function gitFailureFor(cwd: string, args: string[], err: unknown): Promise<GitError> {
  return classifyGitFailure(cwd, args, err as ExecFailure)
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ['rev-parse', '--is-inside-work-tree'], 10_000)
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Raises unless `dir` is a git working tree.
 *
 * `isGitRepo` collapses three different failures into `false` — no git on
 * PATH, no such directory, not a repository — and a caller that has to
 * explain itself to a person needs them apart. This lets the classified
 * failure through instead of flattening it into a boolean.
 */
export async function assertGitRepo(dir: string): Promise<void> {
  const out = (await git(dir, ['rev-parse', '--is-inside-work-tree'], 10_000)).trim()
  if (out !== 'true') {
    raise('not_a_repository', `${dir} is not a git working tree.`, { detail: out || undefined })
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
  if (!message.trim()) raise('invalid_input', 'A commit needs a message.')
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
  } catch (err) {
    raise('worktree_missing', `This machine cannot read ${dir}.`, {
      detail: err instanceof Error ? err.message : undefined,
    })
  }
}

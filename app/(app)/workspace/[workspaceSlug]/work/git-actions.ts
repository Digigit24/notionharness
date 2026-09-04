'use server'

// R5.1/R5.4/R5.5 — the git surface for a conversation bound to a worktree.
//
// Everything below reads or writes ONE checkout: the worktree this chat
// session is bound to. That scoping is the whole safety story. A session that
// is not bound to a worktree gets `null` and the rail does not render, rather
// than falling back to some default repository and letting someone stage
// changes in a checkout they were not looking at.
//
// The git primitives already existed in `lib/git/repo.ts`. What was missing
// was any way to reach them from the conversation, which is where the person
// actually is when they want to know what the agent just changed.

import { getCurrentPayloadUser } from '@/lib/current-user'
import { getWorktree, getChatSession } from '@/lib/broker'
import {
  commit as gitCommit,
  directoryExists,
  isGitRepo,
  git,
  readCommits,
  readDiff,
  readGhStatus,
  readStatus,
  runGh,
  stagePaths,
  unstagePaths,
  type GitCommit,
  type GitFileChange,
} from '@/lib/git/repo'

async function requireUser() {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')
  return user
}

/**
 * Resolves a session to the checkout it is bound to.
 *
 * Every action in this file goes through here, so there is exactly one place
 * that decides which directory a git command may touch — and it is derived
 * from stored state, never from anything a caller passes in.
 */
async function resolveSessionRepo(sessionId: number): Promise<{ dir: string; branch: string } | null> {
  const session = await getChatSession(sessionId)
  if (!session?.worktreeId) return null
  const worktree = await getWorktree(session.worktreeId)
  if (!worktree) return null
  if (!(await directoryExists(worktree.path))) return null
  if (!(await isGitRepo(worktree.path))) return null
  return { dir: worktree.path, branch: worktree.branch }
}

export interface SessionGitState {
  /** Null when this session is not bound to a checkout, or the checkout is
   * gone. The rail renders nothing rather than guessing at a repository. */
  bound: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  clean: boolean
  changes: GitFileChange[]
  recent: GitCommit[]
  /** Whether `gh` is installed and authenticated, so the UI can offer a pull
   * request only when it can actually open one. */
  ghReady: boolean
  ghDetail: string | null
  error: string | null
}

const EMPTY: SessionGitState = {
  bound: false,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  clean: true,
  changes: [],
  recent: [],
  ghReady: false,
  ghDetail: null,
  error: null,
}

export async function getSessionGitState(sessionId: number): Promise<SessionGitState> {
  await requireUser()
  const repo = await resolveSessionRepo(sessionId)
  if (!repo) return EMPTY
  try {
    // Independent reads, so they go together. `readGhStatus` in particular
    // shells out to another binary and would otherwise serialise behind the
    // two git calls for no reason (D0).
    const [status, recent, gh] = await Promise.all([
      readStatus(repo.dir),
      readCommits(repo.dir, 8).catch(() => []),
      readGhStatus().catch(() => ({ installed: false, authenticated: false, detail: null })),
    ])
    return {
      bound: true,
      branch: status.branch ?? repo.branch,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      clean: status.clean,
      changes: status.changes,
      recent,
      ghReady: Boolean(gh.installed && gh.authenticated),
      ghDetail: gh.detail ?? null,
      error: null,
    }
  } catch (err) {
    // A broken checkout must not take the conversation down with it.
    return { ...EMPTY, bound: true, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface SessionDiff {
  patch: string
  truncated: boolean
  /** Which side this patch came from, so the viewer can say so. */
  staged: boolean
}

export async function getSessionDiff(
  sessionId: number,
  options: { path?: string; staged?: boolean } = {},
): Promise<SessionDiff | null> {
  await requireUser()
  const repo = await resolveSessionRepo(sessionId)
  if (!repo) return null
  const { patch, truncated } = await readDiff(repo.dir, { path: options.path, staged: options.staged })
  return { patch, truncated, staged: Boolean(options.staged) }
}

export async function stageSessionPaths(sessionId: number, paths: string[]): Promise<void> {
  await requireUser()
  const repo = await resolveSessionRepo(sessionId)
  if (!repo) throw new Error('This conversation is not bound to a checkout.')
  if (paths.length === 0) return
  await stagePaths(repo.dir, paths)
}

export async function unstageSessionPaths(sessionId: number, paths: string[]): Promise<void> {
  await requireUser()
  const repo = await resolveSessionRepo(sessionId)
  if (!repo) throw new Error('This conversation is not bound to a checkout.')
  if (paths.length === 0) return
  await unstagePaths(repo.dir, paths)
}

/**
 * Commits what is staged.
 *
 * The message is always the human's — `suggestCommitMessage` below drafts one,
 * but nothing commits without a person pressing the button, and the text they
 * see is the text that is used. An automatic commit is the one thing this
 * surface must never do: it puts an agent's work into history under someone
 * else's name with nobody having read it.
 */
export async function commitSession(sessionId: number, message: string): Promise<GitCommit | null> {
  await requireUser()
  const repo = await resolveSessionRepo(sessionId)
  if (!repo) throw new Error('This conversation is not bound to a checkout.')
  const text = message.trim()
  if (!text) throw new Error('A commit needs a message.')
  return gitCommit(repo.dir, text)
}

/**
 * Drafts a commit message from what is actually staged.
 *
 * Deliberately mechanical rather than model-generated: it reads the staged
 * paths and summarises them. A model call here would add a round trip and a
 * cost to a field the human is about to rewrite anyway, and the useful part of
 * a suggestion at this moment is "which files am I committing", which the
 * repository already knows.
 */
export async function suggestCommitMessage(sessionId: number): Promise<string> {
  await requireUser()
  const repo = await resolveSessionRepo(sessionId)
  if (!repo) return ''
  const status = await readStatus(repo.dir)
  const staged = status.changes.filter((c) => c.staged).map((c) => c.path)
  if (staged.length === 0) return ''
  if (staged.length === 1) return `Update ${staged[0]}`
  // A shared directory is the closest thing to a subject a mechanical
  // summary can honestly offer.
  const segments = staged.map((p) => p.split('/').slice(0, -1).join('/')).filter(Boolean)
  const common = segments.length > 0 && segments.every((s) => s === segments[0]) ? segments[0] : null
  return common ? `Update ${staged.length} files in ${common}` : `Update ${staged.length} files`
}

export interface PushResult {
  pushed: boolean
  /** Present when a pull request was opened. */
  prUrl?: string
  detail: string
}

/**
 * Pushes the branch, and optionally opens a pull request.
 *
 * Both are outward-facing and both are explicit: the caller passes
 * `openPullRequest` only after a person has confirmed it in the UI. Pushing
 * publishes work to a remote other people can see, so it is never something
 * that happens as a side effect of another action.
 */
export async function pushSession(
  sessionId: number,
  options: { openPullRequest?: boolean; title?: string; body?: string } = {},
): Promise<PushResult> {
  await requireUser()
  const repo = await resolveSessionRepo(sessionId)
  if (!repo) throw new Error('This conversation is not bound to a checkout.')

  const status = await readStatus(repo.dir)
  const branch = status.branch
  if (!branch) throw new Error('This checkout has no branch to push (detached HEAD).')

  // `-u` so a branch created locally gains its upstream on first push and the
  // ahead/behind counts in the rail start being meaningful immediately.
  await git(repo.dir, ['push', '-u', 'origin', branch], 120_000)

  if (!options.openPullRequest) {
    return { pushed: true, detail: `Pushed ${branch} to origin.` }
  }

  const gh = await readGhStatus()
  if (!gh.installed || !gh.authenticated) {
    // The push already happened and must be reported as such; only the pull
    // request could not be created.
    return { pushed: true, detail: `Pushed ${branch}, but gh is not available to open a pull request.` }
  }
  const title = options.title?.trim() || `Changes from ${branch}`
  // `gh` directly, through the same execFile helper `readGhStatus` uses. An
  // earlier version of this smuggled the arguments through `git(...)` with a
  // sentinel first element, which actually ran `git !gh pr create`, failed,
  // and had its failure swallowed — a wasted process spawn on every pull
  // request, invisible because the real call came straight after it.
  const created = await runGh(
    repo.dir,
    ['pr', 'create', '--head', branch, '--title', title, '--body', options.body?.trim() || ''],
    120_000,
  )
  // `gh pr create` prints the new PR's URL on its own line.
  const url = created
    .trim()
    .split(String.fromCharCode(10))
    .find((line) => line.startsWith('http'))
  return { pushed: true, prUrl: url, detail: url ? `Opened ${url}` : `Pushed ${branch}.` }
}

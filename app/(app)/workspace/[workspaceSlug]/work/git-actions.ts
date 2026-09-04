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
import { getPayloadClient } from '@/lib/payload'
import { getWorktree, getChatSession } from '@/lib/broker'
import {
  HunkStaleError,
  stageHunk,
  summariseFileHunks,
  unstageHunk,
  type HunkSummary,
  type HunkTarget,
} from '@/lib/git/hunks'
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
 * This decides WHICH directory a git command may touch, derived from stored
 * state and never from anything a caller passes in. It does not decide
 * WHETHER the caller may touch it — that is `resolveScopedSessionRepo` and
 * `requireSessionRepoForMember`, which every exported action goes through.
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

/**
 * The same resolution, plus the workspace-membership check, returning null
 * instead of throwing.
 *
 * `sessionId` arrives from the browser, and `resolveSessionRepo` on its own
 * only stops a caller naming a DIRECTORY — it happily resolves someone
 * else's session id to someone else's checkout. The reads below used to do
 * exactly that: any logged-in user could read another workspace's diff, and
 * the writes could stage, commit and push into it. Membership is derived from
 * the session row's own workspace, never from a workspace id the caller
 * supplies (which is all `work/actions.ts`'s `requireSession` checks).
 *
 * Null rather than a throw for the read paths, because they already have a
 * "not bound to a checkout" empty state and a stranger probing session ids
 * should not be able to tell the two apart.
 */
async function resolveScopedSessionRepo(sessionId: number): Promise<{ dir: string; branch: string } | null> {
  const user = await requireUser()
  const session = await getChatSession(sessionId)
  if (!session) return null
  // The membership read is a database round trip and the repo resolution
  // shells out to git; serialising them would cost a spawn for nothing (D0).
  const [repo, allowed] = await Promise.all([
    resolveSessionRepo(sessionId),
    userIsInWorkspace(user.id, session.workspaceId),
  ])
  return allowed ? repo : null
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
  const repo = await resolveScopedSessionRepo(sessionId)
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
  const repo = await resolveScopedSessionRepo(sessionId)
  if (!repo) return null
  const { patch, truncated } = await readDiff(repo.dir, { path: options.path, staged: options.staged })
  return { patch, truncated, staged: Boolean(options.staged) }
}

export async function stageSessionPaths(sessionId: number, paths: string[]): Promise<void> {
  const repo = await requireSessionRepoForMember(sessionId)
  if (paths.length === 0) return
  await stagePaths(repo.dir, paths)
}

export async function unstageSessionPaths(sessionId: number, paths: string[]): Promise<void> {
  const repo = await requireSessionRepoForMember(sessionId)
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
  const repo = await requireSessionRepoForMember(sessionId)
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
  const repo = await resolveScopedSessionRepo(sessionId)
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
  const repo = await requireSessionRepoForMember(sessionId)

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

// ---------------------------------------------------------------------------
// R5.2 — hunk staging.
//
// Staging a whole file is the wrong granularity for reviewing what an agent
// did: a run usually touches one file for two unrelated reasons, and the
// choice a person wants to make is "this change yes, that one not yet". The
// actions below are the server half of that; the client half is
// `components/review/hunk-staged-diff.tsx`.
//
// The mechanics live in `lib/git/hunks.ts` (synthesised single-hunk patch,
// `git apply --cached`, `--reverse` to take one back out). What lives here is
// the scoping.

/** Owner-or-member, read the way `app/api/runs/[id]/events/stream/route.ts`
 * reads it. There is no shared helper for this yet, and inventing one would
 * mean editing files this unit does not own. */
async function userIsInWorkspace(userId: number, workspaceId: number): Promise<boolean> {
  const payload = await getPayloadClient()
  const workspace = await payload
    .findByID({ collection: 'workspaces', id: workspaceId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!workspace) return false
  const ownerId = typeof workspace.owner === 'number' ? workspace.owner : workspace.owner?.id
  const memberIds = Array.isArray(workspace.members)
    ? workspace.members.map((member) => (typeof member === 'number' ? member : member.id))
    : []
  return ownerId === userId || memberIds.includes(userId)
}

/**
 * Same session resolution as everything else in this file, plus a workspace
 * membership check.
 *
 * `sessionId` arrives from the browser. `resolveSessionRepo` turns it into a
 * directory purely from stored state, which stops a caller naming a directory
 * — but on its own it does NOT stop a caller naming SOMEONE ELSE'S session
 * id and staging, unstaging, committing or pushing in another workspace's
 * checkout. `work/actions.ts` compares the session against a workspace id the
 * CALLER supplies, which is not a membership check either. Here it is derived
 * from the session row's own workspace and checked against the logged-in user.
 *
 * The membership read runs alongside the repo resolution because the latter
 * shells out to `git rev-parse`; serialising them would put a process spawn in
 * front of a database round trip for nothing (D0).
 */
async function requireSessionRepoForMember(sessionId: number): Promise<{ dir: string; branch: string }> {
  const user = await requireUser()
  const session = await getChatSession(sessionId)
  if (!session) throw new Error('That conversation no longer exists.')

  const [repo, allowed] = await Promise.all([
    resolveSessionRepo(sessionId),
    userIsInWorkspace(user.id, session.workspaceId),
  ])
  if (!allowed) throw new Error('That conversation belongs to another workspace.')
  if (!repo) throw new Error('This conversation is not bound to a checkout.')
  return repo
}

/**
 * A repository-relative path is the only kind this accepts.
 *
 * `git diff -- ../elsewhere` would fail on its own, but that is relying on a
 * message rather than on a rule. An absolute path or a `..` segment is refused
 * before git sees it, and the patch that comes back is matched against this
 * same path again inside `selectHunk` — so naming one file and staging
 * another's hunk stays impossible even if a pathspec did something surprising.
 */
function assertRepoRelativePath(path: string): string {
  const value = path.trim()
  if (!value) throw new Error('No file path given.')
  const normalised = value.replace(/\\/g, '/')
  if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) {
    throw new Error('Only paths inside the checkout can be staged.')
  }
  if (normalised.split('/').some((segment) => segment === '..')) {
    throw new Error('Only paths inside the checkout can be staged.')
  }
  return normalised
}

/**
 * Big enough for any file a person will actually read hunk by hunk, and a hard
 * limit rather than a truncation: a patch cut off mid-hunk still parses, and
 * applying its last hunk would write half a change into the index. Anything
 * larger reports itself unavailable and the caller falls back to staging the
 * whole file.
 */
const HUNK_PATCH_MAX_BYTES = 2_000_000

/** An alias rather than a second declaration: the boundary metadata is
 * produced by `lib/git/hunks.ts` and is covered by the tests that also cover
 * the patch synthesis, so the two cannot drift apart on what an index or a
 * fingerprint means. */
export type SessionHunk = HunkSummary

export interface SessionFileHunks {
  path: string
  patch: string
  staged: boolean
  isBinary: boolean
  hunks: SessionHunk[]
  /** Set when per-hunk staging cannot be offered for this file, with the
   * reason to show. The diff itself is still returned. */
  unavailable: string | null
}

/** Shared by the read action and the two write actions, so a stage returns the
 * new state of the file without the client having to ask for it. */
async function readFileHunks(dir: string, filePath: string, staged: boolean): Promise<SessionFileHunks> {
  const { patch, truncated } = await readDiff(dir, { path: filePath, staged, maxBytes: HUNK_PATCH_MAX_BYTES })
  const base = { path: filePath, patch, staged, isBinary: false, hunks: [] as SessionHunk[] }

  if (truncated) {
    return {
      ...base,
      unavailable: 'This diff is too large to stage hunk by hunk — stage the whole file instead.',
    }
  }

  const summary = summariseFileHunks(patch, filePath)
  // An untracked file has no diff at all, and neither has a clean one. Nothing
  // to offer and nothing to apologise for.
  if (!summary.found) return { ...base, unavailable: null }
  if (summary.isBinary) return { ...base, isBinary: true, unavailable: 'Binary file — it can only be staged whole.' }
  if (summary.multipleFiles) {
    // A pathspec that matched more than one file: refuse rather than guess
    // which file the hunk indexes belong to.
    return {
      ...base,
      unavailable: 'That path matched more than one file — open a single file to stage its hunks.',
    }
  }

  return { ...base, unavailable: null, hunks: summary.hunks }
}

/**
 * One file's diff AND its hunk boundaries, in a single call.
 *
 * Deliberately not "call `getSessionDiff`, then a second action for the
 * hunks": the panel needs both to paint, and two round trips to render one
 * file is exactly the latency D0 is about. The patch is parsed server-side and
 * only the boundaries cross the wire — the client never sends patch text back,
 * which keeps `git apply --cached` fed exclusively by bytes git itself
 * produced seconds earlier.
 */
export async function getSessionFileHunks(
  sessionId: number,
  path: string,
  options: { staged?: boolean } = {},
): Promise<SessionFileHunks> {
  const repo = await requireSessionRepoForMember(sessionId)
  return readFileHunks(repo.dir, assertRepoRelativePath(path), Boolean(options.staged))
}

export interface HunkApplyResult {
  ok: boolean
  /** Present when `ok` is false, and already a sentence for a human — "this
   * hunk no longer applies, refresh" rather than `error: patch failed:
   * lib/x.ts:41`. */
  message?: string
  /** True specifically when the file moved underneath, so the caller can tell
   * a stale diff from a refusal. */
  stale?: boolean
  /** The same side of the diff, re-read after the apply. Returned with the
   * result so a click costs ONE round trip instead of "apply, then fetch the
   * new diff" — the hunk list always changes, so the second call was
   * guaranteed, which is exactly the shape D0 calls out. */
  next?: SessionFileHunks
}

/**
 * Returned rather than thrown.
 *
 * A `throw` from a server action reaches the browser as an opaque digest in a
 * production build, and the message this feature most needs to deliver intact
 * is precisely the "your diff is stale" one. Genuine faults — not bound to a
 * checkout, not a member of the workspace — still throw, because those are
 * bugs or attacks, not states the UI should narrate.
 */
async function applyHunk(
  sessionId: number,
  input: { path: string; hunkIndex: number; fingerprint: string },
  direction: 'stage' | 'unstage',
): Promise<HunkApplyResult> {
  const repo = await requireSessionRepoForMember(sessionId)
  const filePath = assertRepoRelativePath(input.path)
  if (!Number.isInteger(input.hunkIndex) || input.hunkIndex < 0) throw new Error('Bad hunk reference.')
  if (!input.fingerprint) throw new Error('Bad hunk reference.')

  // Staging reads the unstaged diff (index → worktree) and applies it forward;
  // unstaging reads the staged diff (HEAD → index) and reverses it. Same side
  // is what the caller is looking at, so it is also what gets returned.
  const side = direction === 'unstage'
  const current = await readFileHunks(repo.dir, filePath, side)
  if (current.unavailable) return { ok: false, message: current.unavailable, next: current }

  const target: HunkTarget = { path: filePath, index: input.hunkIndex, fingerprint: input.fingerprint }
  try {
    // Re-read rather than trusting whatever the client last saw: staging is a
    // write, and the only patch that may be applied is one this process just
    // got out of git. Accepting patch text from the browser would turn
    // `git apply --cached` into a write-anything primitive.
    if (direction === 'stage') await stageHunk(repo.dir, current.patch, target)
    else await unstageHunk(repo.dir, current.patch, target)
  } catch (err) {
    // The file can also change between that read and the apply. git catches
    // that race itself and `lib/git/hunks.ts` maps its message onto the same
    // error, so both land here saying the same thing — and both come back with
    // a fresh diff so the person is looking at the truth immediately.
    if (err instanceof HunkStaleError) {
      return {
        ok: false,
        stale: true,
        message: err.message,
        next: await readFileHunks(repo.dir, filePath, side).catch(() => undefined),
      }
    }
    throw err
  }
  return { ok: true, next: await readFileHunks(repo.dir, filePath, side) }
}

/** Stages one hunk. The worktree is untouched — the change is already in it,
 * only the index gains it. */
export async function stageSessionHunk(
  sessionId: number,
  input: { path: string; hunkIndex: number; fingerprint: string },
): Promise<HunkApplyResult> {
  return applyHunk(sessionId, input, 'stage')
}

/** Takes one hunk back out of the index, leaving the rest of the file staged
 * and the worktree exactly as it was. */
export async function unstageSessionHunk(
  sessionId: number,
  input: { path: string; hunkIndex: number; fingerprint: string },
): Promise<HunkApplyResult> {
  return applyHunk(sessionId, input, 'unstage')
}

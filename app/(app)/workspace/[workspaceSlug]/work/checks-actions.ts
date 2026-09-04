'use server'

// R5.6 — the CI verdict for a conversation, and the one click that hands a
// failing job's logs to the agent.
//
// Same scoping rule as `git-actions.ts`, for the same reason: every action
// resolves the session to its bound worktree server-side, so there is exactly
// one place that decides which checkout is being asked about and it comes
// from stored state rather than from anything a caller passes in. A session
// with no worktree gets an unavailable snapshot, never a fallback repository.

import { getCurrentPayloadUser } from '@/lib/current-user'
import { getChatSession, getWorktree } from '@/lib/broker'
import { directoryExists, isGitRepo, readStatus } from '@/lib/git/repo'
import {
  composeFailingChecksPrompt as composePrompt,
  readChecks,
  type ChecksSnapshot,
} from '@/lib/git/checks'

async function requireUser() {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')
  return user
}

/**
 * Resolves a session to the checkout it is bound to.
 *
 * A near-copy of the private `resolveSessionRepo` in `git-actions.ts`. It is
 * duplicated rather than shared because that file is owned by another change
 * in flight and exporting from it here would collide; the honest fix is to
 * hoist one copy into `lib/git/repo.ts` (or a small `lib/git/session.ts`) and
 * have both action files import it. Noted rather than quietly diverged: two
 * copies of a safety boundary is exactly the kind of thing that drifts.
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

export interface SessionChecksState extends ChecksSnapshot {
  /** False when the session is not bound to a checkout at all — a different
   * state from "gh could not answer", and the chip says so differently. */
  bound: boolean
}

const UNBOUND: SessionChecksState = {
  bound: false,
  available: false,
  reason: 'This conversation is not bound to a checkout.',
  source: null,
  branch: null,
  items: [],
  counts: { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 },
  empty: true,
}

/**
 * The CI verdict for this conversation's checkout.
 *
 * Read on demand — when the chip mounts and when a person asks again — and
 * never on an interval. D0 forbids polling where a push exists and treats an
 * interval as a design failure otherwise; this spawns `gh`, which reaches
 * GitHub over the network, and putting that on a timer would be a background
 * request every few seconds for a panel nobody is looking at. GitHub does
 * push (check_run webhooks), but this app has no public endpoint to receive
 * one, so on-demand is the honest answer rather than the lazy one.
 */
export async function getSessionChecks(sessionId: number): Promise<SessionChecksState> {
  await requireUser()
  const repo = await resolveSessionRepo(sessionId)
  if (!repo) return UNBOUND
  // The worktree's recorded branch can be stale — someone may have switched
  // branches in that checkout by hand — and asking GitHub about the wrong
  // branch would produce a confident, wrong verdict.
  const branch = await readStatus(repo.dir)
    .then((status) => status.branch ?? repo.branch)
    .catch(() => repo.branch)
  try {
    return { bound: true, ...(await readChecks(repo.dir, branch)) }
  } catch (err) {
    // A broken gh must not take the conversation down with it; the chip shows
    // a disabled control carrying this text.
    return {
      ...UNBOUND,
      bound: true,
      branch,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface FailingChecksPromptResult {
  prompt: string
  /** True when at least one log was cut to fit. The UI must say so — a
   * silently truncated log that reads as complete is the failure mode this
   * whole feature is most likely to have. */
  capped: boolean
  /** Failing checks whose logs did not make it into the prompt, named. */
  omittedChecks: string[]
  /** Checks whose logs gh could not read at all (third-party statuses,
   * expired logs), with the reason. */
  unreadable: Array<{ name: string; reason: string }>
}

/**
 * Composes the prompt that hands the failing job's logs to an agent.
 *
 * Returns the text rather than sending it. That is a deliberate stop, not an
 * unfinished wiring: the same rule as R5.4's commit message applies — the
 * text the person sees is the text that is used. It also lets them add "and
 * do not touch the workflow file" before pressing Send, which is exactly the
 * kind of instruction that makes the difference between a useful fix and a
 * wrong one. The caller drops it into the composer.
 */
export async function composeFailingChecksPrompt(sessionId: number): Promise<FailingChecksPromptResult | null> {
  await requireUser()
  const repo = await resolveSessionRepo(sessionId)
  if (!repo) throw new Error('This conversation is not bound to a checkout.')
  const branch = await readStatus(repo.dir)
    .then((status) => status.branch ?? repo.branch)
    .catch(() => repo.branch)

  const snapshot = await readChecks(repo.dir, branch)
  if (!snapshot.available) throw new Error(snapshot.reason ?? 'GitHub checks are not available here.')

  const composed = await composePrompt(repo.dir, snapshot)
  if (!composed) return null
  return {
    prompt: composed.prompt,
    capped: composed.capped,
    omittedChecks: composed.omittedChecks,
    unreadable: composed.logs
      .filter((log) => log.error)
      .map((log) => ({ name: log.name, reason: log.error as string })),
  }
}

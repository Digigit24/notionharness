/**
 * R12-P1.4 — the dispatcher's failure taxonomy, written down as code.
 *
 * WHY THIS EXISTS.
 *
 * Every settle in `worker.ts` used to decide requeue-or-not at the call site,
 * and the decisions disagreed with each other. Two of them were literally
 * `retryable: true` for anything that reached them, and one — the agent
 * lookup — was `retryable: false` for anything that reached IT. That last one
 * is not a hypothetical: a transient Postgres pool exhaustion made the lookup
 * throw, the run was settled "Agent missing or disabled." and NON-retryable,
 * and a run that would have succeeded on the very next tick was killed with an
 * explanation that sent whoever read it to look at the agent instead of the
 * database. The lesson is not "be more careful at that call site"; it is that a
 * per-call-site judgement about retryability will always drift. So there is one
 * table, here, and the call sites ask it.
 *
 * WHAT A ROW MEANS.
 *
 * `retryable` is the dispatcher's own question — should `settleRun` enqueue a
 * fresh attempt — and it is answered "does trying this again, unchanged, have a
 * real chance of working". A missing binary does not. A pool with no free
 * connections does. Retries are bounded by `runs.max_attempts` either way, so
 * the cost of a wrong `true` is one wasted attempt while the cost of a wrong
 * `false` is a dead run, which is why anything unrecognised stays retryable.
 *
 * Cancellation is deliberately NOT a failure code. A person pressing Stop got
 * exactly what they asked for; settling that as `failed` put it in the failed
 * column, pushed "Run failed" at them, and — because the old settle passed
 * `retryable: !succeeded` — enqueued a RETRY of the turn they had just stopped.
 */
import type { FailureCode } from '@/lib/failures'
import { isAppFailure } from '@/lib/failures'

/**
 * What the dispatcher should do about a run that did not complete.
 *
 * A union rather than a `cancelled: boolean` field, so a call site cannot
 * settle a stopped run as failed by forgetting to read one property — the two
 * cases do not even carry the same fields.
 */
export type RunDisposition =
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; code: FailureCode; retryable: boolean }

export interface DispositionContext {
  /** `run.attempt` (1-based). Only the worktree rows read it — see below. */
  attempt?: number
  /**
   * True when a stop was actually asked for (`runs.cancel_requested_at`, or
   * the in-process control). Authoritative: it beats every pattern below,
   * because a killed process reports whatever the transport happened to say
   * as it closed, and none of that text is about the person who pressed Stop.
   */
  cancellationRequested?: boolean
}

/**
 * Whether the dispatcher requeues, per code.
 *
 * Deliberately not `lib/failures.ts`'s `DEFAULT_RETRYABLE`: that set answers
 * "would a person be right to press Retry", which is a broader and more
 * forgiving question than "should a background loop start this again by
 * itself". `agent_unavailable` is the pair that shows the difference — an
 * agent row that is absent or switched off will still be absent or switched
 * off on the next tick, so the dispatcher must not spin on it, while a person
 * who has just re-enabled the agent is right to retry immediately.
 */
const RETRYABLE_BY_CODE: Partial<Record<FailureCode, boolean>> = {
  db_unavailable: true,
  // A lease lost to another worker means the run is already someone else's
  // problem; requeuing is how it gets picked up rather than abandoned.
  conflict: true,
  runtime_handshake_failed: true,
  timeout: true,
  worktree_missing: true,
  agent_unavailable: false,
  runtime_not_installed: false,
  spend_cap_reached: false,
  run_not_retryable: false,
  git_missing: false,
  not_a_repository: false,
  bad_ref: false,
  worktree_dirty: false,
  repo_too_large: false,
  invalid_input: false,
  unauthenticated: false,
  forbidden: false,
  not_found: false,
}

/** An unrecognised failure is retried. See the header: a wrong `true` costs one
 * bounded attempt, a wrong `false` costs the run. */
const RETRYABLE_WHEN_UNRECOGNISED = true

interface TaxonomyRule {
  test: RegExp
  code: FailureCode
  /** Only where this particular cause disagrees with its code's default. */
  retryable?: (context: DispositionContext) => boolean
}

/**
 * Ordered most-specific first, because several of these co-occur in one
 * message — a pool timeout inside a turn timeout, an ENOENT that is git's
 * rather than the agent binary's — and the narrower cause is the true one.
 */
const RULES: TaxonomyRule[] = [
  // The provider's own cap, not this workspace's: dispatcher-side enforcement
  // of `workspaces.spend_cap_cents` does not exist yet (see
  // `updateSpendCap`'s comment). Ordered above the connection rules because
  // these arrive as an HTTP failure and would otherwise read as one.
  {
    test: /usage limit (has been )?reached|credit balance is too low|insufficient[_ ]quota|spend(ing)? cap|billing hard limit|payment required/i,
    code: 'spend_cap_reached',
  },
  // Pool exhaustion and dropped connections. THE row this taxonomy was written
  // for: every one of these is a database that will very likely answer on the
  // next tick, and every one of them used to kill the run permanently.
  {
    test: /too many clients|connection terminated|connection (was )?(closed|reset)|timeout exceeded when trying to acquire|remaining connection slots|ECONNRESET|ECONNREFUSED|\bpool\b/i,
    code: 'db_unavailable',
  },
  // Another worker took this run while we were still holding it, or the sweeper
  // reclaimed it. Nothing is wrong with the run itself.
  {
    test: /lease (expired|lost|lapsed|is no longer)|reclaimed by another worker|no longer holds the lease/i,
    code: 'conflict',
  },
  // Git's own diagnoses, before the generic "could not create a worktree" row,
  // because these are the reasons a retry cannot fix.
  { test: /not a git repository/i, code: 'not_a_repository' },
  { test: /\bgit\b[^\n]*\bENOENT\b|ENOENT[^\n]*\bgit\b/i, code: 'git_missing' },
  { test: /unknown revision|bad revision|invalid reference|pathspec .* did not match/i, code: 'bad_ref' },
  {
    // `worktree add` and `clone --bare` are matched as the command line
    // `promisify(execFile)` puts in its own message ("Command failed: git
    // --git-dir … worktree add …"), which is the form these actually arrive in
    // from `RunWorktreeManager`.
    test: /(could not|failed to|unable to) (create|prepare|add) [^\n]*worktree|\bworktree (add|prune)\b|clone --bare|worktree [^\n]*already exists|is already checked out/i,
    // Retryable once, then not — see `runDisposition`, which is where that
    // rule lives so the explicit and pattern-matched paths share it.
    code: 'worktree_missing',
  },
  // The runtime profile points at a command this machine cannot run. Below the
  // git rows so git's own ENOENT is never read as the agent binary's.
  {
    test: /spawn [^\n]*ENOENT|command not found|is not recognized as an internal or external command|\bENOENT\b/i,
    code: 'runtime_not_installed',
  },
  // The process started but never finished the ACP handshake. Usually a
  // machine under load rather than a broken install, so it is worth another
  // attempt — and if it is a broken install, the attempt cap ends it quickly.
  {
    test: /(initiali[sz]e|initiali[sz]ation|handshake|session\/new)[^\n]*(timed? ?out|timeout)|timed out (waiting for|during) [^\n]*(initiali|handshake|acp)/i,
    code: 'runtime_handshake_failed',
  },
  // Nobody answered the approval in time. Terminal for the TURN and not for
  // the run: re-running it would re-ask the same question of the same absent
  // person, on a loop, until the attempts ran out. What unblocks this is
  // someone answering in the Inbox, and they can start it again from there.
  {
    test: /(approval|permission)[^\n]*(timed? ?out|timeout|was never answered)/i,
    code: 'timeout',
    retryable: () => false,
  },
  { test: /timed? ?out|timeout|wall-clock|no output for|inactivity/i, code: 'timeout' },
  // A model that stopped for its own reasons. Running the identical prompt
  // again produces the identical refusal, and the token ceiling does not move
  // between attempts.
  { test: /^(refusal|max_tokens|max_turn_requests)$/i, code: 'run_not_retryable' },
  // The backstop for the settle text the worker writes itself, so a run
  // settled by one path and re-read by another is classified the same way.
  { test: /agent (is )?(missing|disabled)|runtime profile (is )?(missing|disabled)/i, code: 'agent_unavailable' },
]

/**
 * A stop reason ACP hands back verbatim, so it is the WHOLE string rather than
 * a word inside a sentence. Anything looser would read an agent's own account
 * of cancelling something as the turn having been cancelled.
 */
const CANCELLED_TEXT = /^(cancell?ed|aborted)$/i

/**
 * The disposition for a cause we already know by name.
 *
 * Used where the dispatcher does not need to guess — it looked the agent up
 * and there was no agent — so that the explicit path and the pattern-matched
 * path cannot disagree about whether that cause comes back.
 */
export function runDisposition(code: FailureCode, context: DispositionContext = {}): RunDisposition {
  if (code === 'worktree_missing') {
    // Retryable ONCE, which is the only entry here that depends on history. A
    // checkout that could not be created because a previous run left a lock or
    // a half-removed directory behind is exactly what one fresh attempt fixes;
    // a second identical failure is the repository or the disk saying
    // something, and a third attempt only delays whoever has to look at it.
    return { outcome: 'failed', code, retryable: (context.attempt ?? 1) <= 1 }
  }
  return { outcome: 'failed', code, retryable: RETRYABLE_BY_CODE[code] ?? RETRYABLE_WHEN_UNRECOGNISED }
}

/**
 * Classify anything a failed turn produced — a thrown error, or the `reason`
 * string off a `done` event — into a settle decision.
 */
export function classifyRunFailure(err: unknown, context: DispositionContext = {}): RunDisposition {
  if (context.cancellationRequested) return { outcome: 'cancelled' }

  // An `AppFailure` carries a code somebody chose on purpose, so it wins over
  // every pattern below. Deliberately `isAppFailure` and not `toFailureInfo`:
  // that helper also GUESSES a code from the message, and its guess is
  // coarser than this table — it reads "the approval timed out" as a plain
  // timeout, which is the one case here that must not be retried.
  if (isAppFailure(err)) return runDisposition(err.code, context)

  const text = (err instanceof Error ? err.message : String(err ?? '')).trim()
  if (CANCELLED_TEXT.test(text)) return { outcome: 'cancelled' }

  for (const rule of RULES) {
    if (!rule.test.test(text)) continue
    if (!rule.retryable) return runDisposition(rule.code, context)
    return { outcome: 'failed', code: rule.code, retryable: rule.retryable(context) }
  }
  return { outcome: 'failed', code: 'unknown', retryable: RETRYABLE_WHEN_UNRECOGNISED }
}
